param(
  [Parameter(Mandatory = $true)][string]$Executable,
  [Parameter(Mandatory = $true)][string]$Config,
  [Parameter(Mandatory = $true)][int]$SupervisorPid
)
$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathRooted($Executable) -or -not [IO.Path]::IsPathRooted($Config) -or
    [IO.Path]::GetFileName($Executable) -ne 'caddy' -or -not (Test-Path -LiteralPath $Executable -PathType Leaf) -or
    -not (Test-Path -LiteralPath $Config -PathType Leaf) -or $SupervisorPid -le 0) { throw 'Invalid Caddy launch parameters.' }

# CreateProcess can start a Windows PE image without a suffix when its exact
# path is supplied as lpApplicationName. A job object ensures the child is
# stopped if this small launcher exits unexpectedly.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NotionSmartNative {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb; public string reserved, desktop, title;
    public int x, y, xSize, ySize, xCountChars, yCountChars, fillAttribute, flags;
    public short showWindow, reserved2; public IntPtr reservedPtr, stdInput, stdOutput, stdError;
  }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr process, thread; public int processId, threadId; }
  [StructLayout(LayoutKind.Sequential)] public struct BASIC_LIMITS {
    public long processTime, jobTime; public uint flags; public UIntPtr minWorkingSet, maxWorkingSet;
    public uint activeProcesses; public UIntPtr affinity; public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS { public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; }
  [StructLayout(LayoutKind.Sequential)] public struct EXTENDED_LIMITS {
    public BASIC_LIMITS basic; public IO_COUNTERS io; public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CreateProcessW(string app, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes,
    bool inheritHandles, uint flags, IntPtr environment, string currentDirectory, ref STARTUPINFO startup, out PROCESS_INFORMATION result);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref EXTENDED_LIMITS info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
}
'@
$job = [NotionSmartNative]::CreateJobObjectW([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) { throw "Could not create Caddy job ($([Runtime.InteropServices.Marshal]::GetLastWin32Error()))." }
$supervisor = [NotionSmartNative]::OpenProcess(0x00100000, $false, $SupervisorPid) # SYNCHRONIZE
if ($supervisor -eq [IntPtr]::Zero) { [void][NotionSmartNative]::CloseHandle($job); throw 'The Caddy supervisor is no longer running.' }
$processInfo = [NotionSmartNative+PROCESS_INFORMATION]::new()
try {
  $limits = [NotionSmartNative+EXTENDED_LIMITS]::new()
  $basic = $limits.basic
  $basic.flags = 0x00002000 # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  $limits.basic = $basic
  $size = [uint32][Runtime.InteropServices.Marshal]::SizeOf([type][NotionSmartNative+EXTENDED_LIMITS])
  if (-not [NotionSmartNative]::SetInformationJobObject($job, 9, [ref]$limits, $size)) { throw "Could not configure Caddy job ($([Runtime.InteropServices.Marshal]::GetLastWin32Error()))." }
  $startup = [NotionSmartNative+STARTUPINFO]::new()
  $startup.cb = [Runtime.InteropServices.Marshal]::SizeOf([type][NotionSmartNative+STARTUPINFO])
  $line = [Text.StringBuilder]::new('"' + $Executable + '" run --config "' + $Config + '"')
  $flags = [uint32](0x08000000 -bor 0x00000004) # CREATE_NO_WINDOW | CREATE_SUSPENDED
  $started = [NotionSmartNative]::CreateProcessW($Executable, $line, [IntPtr]::Zero, [IntPtr]::Zero, $false, $flags,
    [IntPtr]::Zero, [IO.Path]::GetDirectoryName($Executable), [ref]$startup, [ref]$processInfo)
  if (-not $started) { throw "Could not start Caddy ($([Runtime.InteropServices.Marshal]::GetLastWin32Error()))." }
  if (-not [NotionSmartNative]::AssignProcessToJobObject($job, $processInfo.process)) {
    [void][NotionSmartNative]::TerminateProcess($processInfo.process, 1)
    throw "Could not supervise Caddy ($([Runtime.InteropServices.Marshal]::GetLastWin32Error()))."
  }
  if ([NotionSmartNative]::ResumeThread($processInfo.thread) -eq [uint32]::MaxValue) {
    [void][NotionSmartNative]::TerminateProcess($processInfo.process, 1)
    throw 'Could not resume Caddy.'
  }
  [Console]::WriteLine('started')
  $wait = [NotionSmartNative]::WaitForMultipleObjects(2, [IntPtr[]]@($processInfo.process, $supervisor), $false, [uint32]::MaxValue)
  if ($wait -eq 1) { exit 0 } # Supervisor died; closing the job stops Caddy.
  if ($wait -ne 0) { throw 'Could not wait for Caddy or its supervisor.' }
  [uint32]$exitCode = 1
  if (-not [NotionSmartNative]::GetExitCodeProcess($processInfo.process, [ref]$exitCode)) { throw 'Could not read Caddy exit status.' }
} finally {
  if ($processInfo.thread -ne [IntPtr]::Zero) { [void][NotionSmartNative]::CloseHandle($processInfo.thread) }
  if ($processInfo.process -ne [IntPtr]::Zero) { [void][NotionSmartNative]::CloseHandle($processInfo.process) }
  [void][NotionSmartNative]::CloseHandle($supervisor)
  [void][NotionSmartNative]::CloseHandle($job)
}
exit $exitCode
