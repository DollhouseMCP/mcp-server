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

    # Snapshot only existing observations, never issue another diagnostic query.
    diagnostic = {'origin': 'finish', 'first': None, 'assigned': -1, 'listed': -1, 'active': -1}

    def record_detail(stage, error=-1):
        if diagnostic['first'] is None:
            diagnostic['first'] = (diagnostic['origin'], stage, error,
                                   diagnostic['assigned'], diagnostic['listed'], diagnostic['active'])

    def api_result(result, stage, wait=False):
        if (wait and result == 0xffffffff) or (not wait and not result):
            # Read immediately at this failing existing API, never at a logical guard.
            record_detail(stage, ctypes.get_last_error() & 0xffffffff)
        return result

    def require(ok, stage='setup'):
        if not ok:
            record_detail(stage)
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

    import os
    import threading
    import time

    class ProcessIds(ctypes.Structure):
        _fields_ = [('Assigned', wintypes.DWORD), ('Listed', wintypes.DWORD),
                    ('Ids', ctypes.c_size_t * 128)]

    require(ProcessIds.Ids.offset == 8)
    require(ctypes.sizeof(ProcessIds) == 8 + 128 * ctypes.sizeof(ctypes.c_size_t))

    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel.TerminateProcess.restype = wintypes.BOOL
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    cancel_file = os.environ['OWNED_FIXTURE_CANCEL_FILE']
    token = os.environ['OWNED_FIXTURE_JOB_TOKEN']
    require(bool(cancel_file) and bool(token))
    own_pid = os.getpid()
    lock = threading.Lock()
    armed = threading.Event()
    stop = threading.Event()
    state = {'proved': False, 'closed': False, 'failure': None, 'failure_sent': False}

    def members():
        ids = ProcessIds()
        require(api_result(kernel.QueryInformationJobObject(job, 3, ctypes.byref(ids), ctypes.sizeof(ids), None), 'members-query'))
        diagnostic['assigned'], diagnostic['listed'] = ids.Assigned, ids.Listed
        require(ids.Listed == ids.Assigned and 0 < ids.Listed <= 128, 'members-counts')
        result = list(ids.Ids[:ids.Listed])
        require(own_pid in result and len(set(result)) == len(result), 'members-identity')
        return result

    def active_count():
        accounting = Accounting()
        require(api_result(kernel.QueryInformationJobObject(job, 1, ctypes.byref(accounting), ctypes.sizeof(accounting), None), 'active-query'))
        diagnostic['active'] = accounting.ActiveProcesses
        return accounting.ActiveProcesses

    def terminate_and_wait(pid, deadline):
        # Open the exact candidate and verify membership on that handle before
        # termination; a reused/unrelated PID can never authorize a signal.
        handle = api_result(kernel.OpenProcess(0x100001 | 0x1000, False, pid), 'process-open')
        require(handle)
        try:
            member = wintypes.BOOL()
            require(api_result(kernel.IsProcessInJob(handle, job, ctypes.byref(member)), 'process-member-query') and member.value, 'process-member-guard')
            result = api_result(kernel.WaitForSingleObject(handle, 0), 'process-wait-before', wait=True)
            require(result in (0, 258), 'process-wait-result')  # WAIT_OBJECT_0 or WAIT_TIMEOUT only.
            if result == 258:
                require(api_result(kernel.TerminateProcess(handle, 3), 'process-terminate'))
            remaining = max(0, int((deadline - time.monotonic()) * 1000))
            require(api_result(kernel.WaitForSingleObject(handle, remaining), 'process-wait-after', wait=True) == 0, 'process-wait-timeout')
        finally:
            require(api_result(kernel.CloseHandle(handle), 'process-close'))

    def refuse_locked(cause):
        # Both callers hold the same mutex. Never turn a prior unknown result
        # into a later successful proof, even after an earlier ACK was emitted.
        if state['failure'] is None:
            state['failure'] = cause
        if not state['failure_sent']:
            state['failure_sent'] = True
            record_detail('exception')
            try:
                print('OWNED_FIXTURE_JOB_DETAIL %s %d %s %s %d %d %d %d' %
                      ((token, own_pid) + diagnostic['first']), file=sys.stderr, flush=True)
            except BaseException:
                pass  # Detail failure cannot suppress the original refusal frame.
            try:
                print('OWNED_FIXTURE_JOB_PROOF_FAILED %s %d' % (token, own_pid), file=sys.stderr, flush=True)
            except BaseException:
                pass  # Broken stderr cannot authorize another proof attempt.

    def quiesce_locked(deadline, cancelling):
        if state['failure'] is not None:
            raise state['failure']
        if state['proved']:
            return
        first = True
        while time.monotonic() < deadline:
            current = members()
            if not cancelling:
                require(current == [own_pid] and active_count() == 1, 'normal-members')
            for pid in current:
                if pid != own_pid:
                    terminate_and_wait(pid, deadline)
            # Fence AFTER verified-handle termination. Preserve containment and
            # bar any new association, including descendants racing the census.
            if first:
                limits.Basic.LimitFlags = 0x2000 | 0x8
                limits.Basic.ActiveProcessLimit = 1
                require(api_result(kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)), 'fence-set'))
                observed = ExtendedLimits()
                require(api_result(kernel.QueryInformationJobObject(job, 9, ctypes.byref(observed), ctypes.sizeof(observed), None), 'fence-query'))
                require(observed.Basic.LimitFlags & 0x2000 and observed.Basic.LimitFlags & 0x8, 'fence-flags')
                require(not observed.Basic.LimitFlags & (0x800 | 0x1000), 'fence-breakaway')
                require(observed.Basic.ActiveProcessLimit == 1, 'fence-limit')
                first = False
            # Re-query after the fence, with completed handles already closed.
            # A raced member requires another bounded settlement iteration.
            if members() == [own_pid] and active_count() == 1:
                print('OWNED_FIXTURE_JOB_QUIESCENT %s %d' % (token, own_pid), file=sys.stderr, flush=True)
                state['proved'] = True
                return
        record_detail('settlement-budget')
        raise OSError('Owned fixture Job Object settlement exceeded cleanup budget')

    def monitor():
        armed.set()
        while not stop.wait(.01):
            if os.path.exists(cancel_file):
                with lock:
                    try:
                        diagnostic['origin'] = 'monitor'
                        if not state['closed']:
                            quiesce_locked(time.monotonic() + 2.5, True)
                    except BaseException as cause:
                        refuse_locked(cause)
                return

    threading.Thread(target=monitor, daemon=True).start()
    armed.wait()  # The cancellation monitor arms before any fixture body work.

    def finish_job():
        stop.set()
        with lock:
            if state['failure'] is not None:
                raise state['failure']
            if state['closed']:
                return
            try:
                diagnostic['origin'] = 'finish'
                quiesce_locked(time.monotonic() + 2.5, False)
                # Clear only kill-on-close after proof. Retain the admission
                # fence until this sole launcher exits; repeated finish is inert.
                limits.Basic.LimitFlags &= ~0x2000
                require(api_result(kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)), 'disarm-set'))
                observed = ExtendedLimits()
                require(api_result(kernel.QueryInformationJobObject(job, 9, ctypes.byref(observed), ctypes.sizeof(observed), None), 'disarm-query'))
                require(observed.Basic.LimitFlags & 0x8 and not observed.Basic.LimitFlags & (0x2000 | 0x800 | 0x1000), 'disarm-flags')
                require(observed.Basic.ActiveProcessLimit == 1, 'disarm-limit')
                require(api_result(kernel.CloseHandle(job), 'job-close'))
                state['closed'] = True
            except BaseException as cause:
                refuse_locked(cause)
                raise

    return finish_job
