package main

import (
	"fmt"
	"io"
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

const (
	createSuspended                        = 0x00000004
	extendedStartupInfoPresent             = 0x00080000
	infinite                               = 0xffffffff
	jobObjectExtendedLimitInformationClass = 9
	jobObjectLimitKillOnJobClose           = 0x00002000
	procThreadAttributePseudoConsole       = 0x00020016
	startfUseStdHandles                    = 0x00000100
	synchronize                            = 0x00100000
	waitObject0                            = 0
)

type jobObjectBasicLimitInformation struct {
	perProcessUserTimeLimit int64
	perJobUserTimeLimit     int64
	limitFlags              uint32
	minimumWorkingSetSize   uintptr
	maximumWorkingSetSize   uintptr
	activeProcessLimit      uint32
	affinity                uintptr
	priorityClass           uint32
	schedulingClass         uint32
}

type ioCounters struct {
	readOperationCount  uint64
	writeOperationCount uint64
	otherOperationCount uint64
	readTransferCount   uint64
	writeTransferCount  uint64
	otherTransferCount  uint64
}

type jobObjectExtendedLimitInformation struct {
	basicLimitInformation jobObjectBasicLimitInformation
	ioInfo                ioCounters
	processMemoryLimit    uintptr
	jobMemoryLimit        uintptr
	peakProcessMemoryUsed uintptr
	peakJobMemoryUsed     uintptr
}

type startupInfoEx struct {
	startupInfo   syscall.StartupInfo
	attributeList uintptr
}

type pseudoConsole struct {
	handle      uintptr
	inputRead   syscall.Handle
	inputWrite  syscall.Handle
	outputWrite syscall.Handle
	outputRead  *os.File
	drained     chan struct{}
}

var (
	kernel32                 = syscall.NewLazyDLL("kernel32.dll")
	assignProcessToJobObject = kernel32.NewProc("AssignProcessToJobObject")
	closeHandle              = kernel32.NewProc("CloseHandle")
	closePseudoConsole       = kernel32.NewProc("ClosePseudoConsole")
	createJobObject          = kernel32.NewProc("CreateJobObjectW")
	createPseudoConsole      = kernel32.NewProc("CreatePseudoConsole")
	deleteAttributeList      = kernel32.NewProc("DeleteProcThreadAttributeList")
	getExitCodeProcess       = kernel32.NewProc("GetExitCodeProcess")
	initializeAttributeList  = kernel32.NewProc("InitializeProcThreadAttributeList")
	openProcess              = kernel32.NewProc("OpenProcess")
	resumeThread             = kernel32.NewProc("ResumeThread")
	setInformationJobObject  = kernel32.NewProc("SetInformationJobObject")
	terminateProcess         = kernel32.NewProc("TerminateProcess")
	updateAttribute          = kernel32.NewProc("UpdateProcThreadAttribute")
	waitForMultipleObjects   = kernel32.NewProc("WaitForMultipleObjects")
)

func fail(format string, args ...any) int {
	fmt.Fprintf(os.Stderr, "windows-radius-launcher: "+format+"\n", args...)
	return 125
}

func closeWindowsHandle(handle syscall.Handle) {
	if handle != 0 {
		closeHandle.Call(uintptr(handle))
	}
}

func lastError(operation string, callError error) error {
	if callError != nil && callError != syscall.Errno(0) {
		return fmt.Errorf("%s: %w", operation, callError)
	}
	return fmt.Errorf("%s failed", operation)
}

func createKillOnCloseJob() (syscall.Handle, error) {
	job, _, callError := createJobObject.Call(0, 0)
	if job == 0 {
		return 0, lastError("CreateJobObjectW", callError)
	}

	information := jobObjectExtendedLimitInformation{}
	information.basicLimitInformation.limitFlags = jobObjectLimitKillOnJobClose
	ok, _, callError := setInformationJobObject.Call(
		job,
		jobObjectExtendedLimitInformationClass,
		uintptr(unsafe.Pointer(&information)),
		unsafe.Sizeof(information),
	)
	if ok == 0 {
		closeWindowsHandle(syscall.Handle(job))
		return 0, lastError("SetInformationJobObject", callError)
	}
	return syscall.Handle(job), nil
}

func openParentProcess(pid uint64) (syscall.Handle, error) {
	handle, _, callError := openProcess.Call(synchronize, 0, uintptr(pid))
	if handle == 0 {
		return 0, lastError("OpenProcess(parent)", callError)
	}
	return syscall.Handle(handle), nil
}

func commandLine(executable string, args []string) string {
	escaped := make([]string, 0, len(args)+1)
	escaped = append(escaped, syscall.EscapeArg(executable))
	for _, arg := range args {
		escaped = append(escaped, syscall.EscapeArg(arg))
	}
	return strings.Join(escaped, " ")
}

func createHeadlessConsole() (*pseudoConsole, error) {
	// ConPTY supplies the console semantics Radius and its descendants require
	// without asking Windows Terminal or conhost to display a window.
	if err := createPseudoConsole.Find(); err != nil {
		return nil, fmt.Errorf("CreatePseudoConsole is unavailable: %w", err)
	}
	var inputRead syscall.Handle
	var inputWrite syscall.Handle
	if err := syscall.CreatePipe(&inputRead, &inputWrite, nil, 0); err != nil {
		return nil, fmt.Errorf("CreatePipe(pseudoconsole input): %w", err)
	}

	var outputRead syscall.Handle
	var outputWrite syscall.Handle
	if err := syscall.CreatePipe(&outputRead, &outputWrite, nil, 0); err != nil {
		closeWindowsHandle(inputRead)
		closeWindowsHandle(inputWrite)
		return nil, fmt.Errorf("CreatePipe(pseudoconsole output): %w", err)
	}

	var handle uintptr
	// COORD is passed by value, with X in the low word and Y in the high word.
	size := uintptr(uint32(80) | uint32(25)<<16)
	result, _, _ := createPseudoConsole.Call(
		size,
		uintptr(inputRead),
		uintptr(outputWrite),
		0,
		uintptr(unsafe.Pointer(&handle)),
	)
	if result != 0 {
		closeWindowsHandle(inputRead)
		closeWindowsHandle(inputWrite)
		closeWindowsHandle(outputRead)
		closeWindowsHandle(outputWrite)
		return nil, fmt.Errorf("CreatePseudoConsole failed with HRESULT 0x%08x", uint32(result))
	}

	output := os.NewFile(uintptr(outputRead), "pseudoconsole-output")
	drained := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, output)
		close(drained)
	}()
	return &pseudoConsole{
		handle:      handle,
		inputRead:   inputRead,
		inputWrite:  inputWrite,
		outputWrite: outputWrite,
		outputRead:  output,
		drained:     drained,
	}, nil
}

func (console *pseudoConsole) close() {
	if console == nil {
		return
	}
	closePseudoConsole.Call(console.handle)
	closeWindowsHandle(console.inputRead)
	closeWindowsHandle(console.inputWrite)
	closeWindowsHandle(console.outputWrite)
	_ = console.outputRead.Close()
	<-console.drained
}

func pseudoConsoleAttributeList(handle uintptr) ([]byte, uintptr, error) {
	var size uintptr
	initializeAttributeList.Call(0, 1, 0, uintptr(unsafe.Pointer(&size)))
	if size == 0 {
		return nil, 0, fmt.Errorf("InitializeProcThreadAttributeList did not report a size")
	}

	buffer := make([]byte, size)
	list := uintptr(unsafe.Pointer(&buffer[0]))
	ok, _, callError := initializeAttributeList.Call(
		list,
		1,
		0,
		uintptr(unsafe.Pointer(&size)),
	)
	if ok == 0 {
		return nil, 0, lastError("InitializeProcThreadAttributeList", callError)
	}
	ok, _, callError = updateAttribute.Call(
		list,
		0,
		procThreadAttributePseudoConsole,
		handle,
		unsafe.Sizeof(handle),
		0,
		0,
	)
	if ok == 0 {
		deleteAttributeList.Call(list)
		return nil, 0, lastError("UpdateProcThreadAttribute(pseudoconsole)", callError)
	}
	return buffer, list, nil
}

func createChild(executable string, args []string) (syscall.ProcessInformation, *pseudoConsole, error) {
	applicationName, err := syscall.UTF16PtrFromString(executable)
	if err != nil {
		return syscall.ProcessInformation{}, nil, fmt.Errorf("invalid executable path: %w", err)
	}
	command, err := syscall.UTF16PtrFromString(commandLine(executable, args))
	if err != nil {
		return syscall.ProcessInformation{}, nil, fmt.Errorf("invalid command line: %w", err)
	}

	console, err := createHeadlessConsole()
	if err != nil {
		return syscall.ProcessInformation{}, nil, err
	}
	attributeBuffer, attributeList, err := pseudoConsoleAttributeList(console.handle)
	if err != nil {
		console.close()
		return syscall.ProcessInformation{}, nil, err
	}
	defer deleteAttributeList.Call(attributeList)

	startup := startupInfoEx{
		startupInfo: syscall.StartupInfo{
			Cb:        uint32(unsafe.Sizeof(startupInfoEx{})),
			Flags:     startfUseStdHandles,
			StdInput:  syscall.Handle(os.Stdin.Fd()),
			StdOutput: syscall.Handle(os.Stdout.Fd()),
			StdErr:    syscall.Handle(os.Stderr.Fd()),
		},
		attributeList: attributeList,
	}
	process := syscall.ProcessInformation{}
	err = syscall.CreateProcess(
		applicationName,
		command,
		nil,
		nil,
		true,
		extendedStartupInfoPresent|createSuspended,
		nil,
		nil,
		&startup.startupInfo,
		&process,
	)
	runtime.KeepAlive(attributeBuffer)
	if err != nil {
		console.close()
		return syscall.ProcessInformation{}, nil, fmt.Errorf("CreateProcessW(%q): %w", executable, err)
	}
	return process, console, nil
}

func run(args []string) int {
	if len(args) < 2 {
		return fail("usage: <parent-pid> <executable> [arguments...]")
	}
	parentPID, err := strconv.ParseUint(args[0], 10, 32)
	if err != nil || parentPID == 0 {
		return fail("invalid parent pid %q", args[0])
	}

	parent, err := openParentProcess(parentPID)
	if err != nil {
		return fail("%v", err)
	}
	defer closeWindowsHandle(parent)

	job, err := createKillOnCloseJob()
	if err != nil {
		return fail("%v", err)
	}

	child, console, err := createChild(args[1], args[2:])
	if err != nil {
		closeWindowsHandle(job)
		return fail("%v", err)
	}
	defer console.close()
	defer closeWindowsHandle(job)
	defer closeWindowsHandle(child.Process)
	defer closeWindowsHandle(child.Thread)

	assigned, _, callError := assignProcessToJobObject.Call(
		uintptr(job),
		uintptr(child.Process),
	)
	if assigned == 0 {
		terminateProcess.Call(uintptr(child.Process), 125)
		return fail("%v", lastError("AssignProcessToJobObject", callError))
	}
	resumed, _, callError := resumeThread.Call(uintptr(child.Thread))
	if resumed == 0xffffffff {
		terminateProcess.Call(uintptr(child.Process), 125)
		return fail("%v", lastError("ResumeThread", callError))
	}

	handles := [...]syscall.Handle{child.Process, parent}
	waitResult, _, callError := waitForMultipleObjects.Call(
		uintptr(len(handles)),
		uintptr(unsafe.Pointer(&handles[0])),
		0,
		infinite,
	)
	if waitResult == waitObject0+1 {
		return 125
	}
	if waitResult != waitObject0 {
		return fail("%v", lastError("WaitForMultipleObjects", callError))
	}

	var exitCode uint32
	ok, _, callError := getExitCodeProcess.Call(
		uintptr(child.Process),
		uintptr(unsafe.Pointer(&exitCode)),
	)
	if ok == 0 {
		return fail("%v", lastError("GetExitCodeProcess", callError))
	}
	return int(exitCode)
}

func main() {
	os.Exit(run(os.Args[1:]))
}
