package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

const (
	createNoWindow                         = 0x08000000
	createSuspended                        = 0x00000004
	infinite                               = 0xffffffff
	jobObjectExtendedLimitInformationClass = 9
	jobObjectLimitKillOnJobClose           = 0x00002000
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

var (
	kernel32                 = syscall.NewLazyDLL("kernel32.dll")
	assignProcessToJobObject = kernel32.NewProc("AssignProcessToJobObject")
	closeHandle              = kernel32.NewProc("CloseHandle")
	createJobObject          = kernel32.NewProc("CreateJobObjectW")
	getExitCodeProcess       = kernel32.NewProc("GetExitCodeProcess")
	openProcess              = kernel32.NewProc("OpenProcess")
	resumeThread             = kernel32.NewProc("ResumeThread")
	setInformationJobObject  = kernel32.NewProc("SetInformationJobObject")
	terminateProcess         = kernel32.NewProc("TerminateProcess")
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

func createChild(executable string, args []string) (syscall.ProcessInformation, error) {
	applicationName, err := syscall.UTF16PtrFromString(executable)
	if err != nil {
		return syscall.ProcessInformation{}, fmt.Errorf("invalid executable path: %w", err)
	}
	command, err := syscall.UTF16PtrFromString(commandLine(executable, args))
	if err != nil {
		return syscall.ProcessInformation{}, fmt.Errorf("invalid command line: %w", err)
	}

	startup := syscall.StartupInfo{
		Cb:        uint32(unsafe.Sizeof(syscall.StartupInfo{})),
		Flags:     startfUseStdHandles,
		StdInput:  syscall.Handle(os.Stdin.Fd()),
		StdOutput: syscall.Handle(os.Stdout.Fd()),
		StdErr:    syscall.Handle(os.Stderr.Fd()),
	}
	process := syscall.ProcessInformation{}
	err = syscall.CreateProcess(
		applicationName,
		command,
		nil,
		nil,
		true,
		createNoWindow|createSuspended,
		nil,
		nil,
		&startup,
		&process,
	)
	if err != nil {
		return syscall.ProcessInformation{}, fmt.Errorf("CreateProcessW(%q): %w", executable, err)
	}
	return process, nil
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
	defer closeWindowsHandle(job)

	child, err := createChild(args[1], args[2:])
	if err != nil {
		return fail("%v", err)
	}
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
