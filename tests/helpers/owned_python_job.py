# Test fixtures only. This code is embedded in the owned Python launcher.
def establish_fixture_job():
    if sys.platform != 'win32':
        return lambda: None
    import ctypes
    from ctypes import wintypes

    class BasicLimits(ctypes.Structure):
        _fields_ = [('ProcessTime', ctypes.c_longlong), ('JobTime', ctypes.c_longlong),
                    ('LimitFlags', wintypes.DWORD), ('MinimumWorkingSet', ctypes.c_size_t),
                    ('MaximumWorkingSet', ctypes.c_size_t), ('ActiveProcessLimit', wintypes.DWORD),
                    ('Affinity', ctypes.c_size_t), ('PriorityClass', wintypes.DWORD),
                    ('SchedulingClass', wintypes.DWORD)]

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in
                    ['ReadOperations', 'WriteOperations', 'OtherOperations',
                     'ReadBytes', 'WriteBytes', 'OtherBytes']]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [('Basic', BasicLimits), ('Io', IoCounters),
                    ('ProcessMemory', ctypes.c_size_t), ('JobMemory', ctypes.c_size_t),
                    ('PeakProcessMemory', ctypes.c_size_t), ('PeakJobMemory', ctypes.c_size_t)]

    class Accounting(ctypes.Structure):
        _fields_ = [('UserTime', ctypes.c_longlong), ('KernelTime', ctypes.c_longlong),
                    ('PeriodUserTime', ctypes.c_longlong), ('PeriodKernelTime', ctypes.c_longlong),
                    ('PageFaultCount', wintypes.DWORD), ('TotalProcesses', wintypes.DWORD),
                    ('ActiveProcesses', wintypes.DWORD), ('TerminatedProcesses', wintypes.DWORD)]

    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.GetCurrentProcess.argtypes = []
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p]
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.IsProcessInJob.argtypes = [wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)]
    kernel.SetHandleInformation.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD]
    kernel.GetHandleInformation.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    for name in ['SetInformationJobObject', 'QueryInformationJobObject', 'AssignProcessToJobObject',
                 'IsProcessInJob', 'SetHandleInformation', 'GetHandleInformation', 'CloseHandle']:
        getattr(kernel, name).restype = wintypes.BOOL

    def require(ok):
        if not ok:
            raise OSError('Owned fixture Job Object setup or verification failed')

    wide = ctypes.sizeof(ctypes.c_size_t) == 8
    require(ctypes.sizeof(BasicLimits) == (64 if wide else 48))
    require(ctypes.sizeof(ExtendedLimits) == (144 if wide else 112))
    require(ctypes.sizeof(Accounting) == 48)
    job = kernel.CreateJobObjectW(None, None)  # Anonymous and non-inheritable.
    require(job)
    require(kernel.SetHandleInformation(job, 1, 0))
    flags = wintypes.DWORD()
    require(kernel.GetHandleInformation(job, ctypes.byref(flags)))
    require(not flags.value & 1)
    limits = ExtendedLimits()
    limits.Basic.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    require(kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)))
    observed = ExtendedLimits()
    require(kernel.QueryInformationJobObject(job, 9, ctypes.byref(observed), ctypes.sizeof(observed), None))
    require(observed.Basic.LimitFlags & 0x2000)
    require(kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess()))
    member = wintypes.BOOL()
    require(kernel.IsProcessInJob(kernel.GetCurrentProcess(), job, ctypes.byref(member)))
    require(member.value)

    def finish_job():
        # Preserve normal helper exit codes. Only disarm the job after verifying
        # that this launcher is its sole remaining process and cannot spawn more.
        accounting = Accounting()
        require(kernel.QueryInformationJobObject(job, 1, ctypes.byref(accounting), ctypes.sizeof(accounting), None))
        require(accounting.ActiveProcesses == 1)
        limits.Basic.LimitFlags = 0
        require(kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)))
        require(kernel.CloseHandle(job))

    return finish_job
