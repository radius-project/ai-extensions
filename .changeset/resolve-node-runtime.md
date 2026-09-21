---
"radius": patch
---

**Fixed:** Stop application modeling from downloading a Node.js runtime when `node` is not on the shell's `PATH`. The extension now resolves an existing Node.js installation — including Homebrew, Volta, scoop, Chocolatey, nvm, and nvm-windows locations — checks that it is Node.js 18 or newer, and hands its absolute path to the modeling skill, which runs its scripts through that interpreter. When no supported installation can be found, modeling stops and asks you to install Node.js — naming any too-old installations it found — instead of installing software on your machine.
