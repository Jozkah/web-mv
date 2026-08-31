# web-mv Ghidra headless post-script: decompile EXACTLY ONE function.
#
# Runs only when the user explicitly requests a single function. It validates the entry address
# (supplied through a controlled script argument by the relay — never a raw name or command), locates
# that one function, decompiles only it, and emits one bounded JSON result. Missing function, timeout,
# and decompiler failure are reported structurally (never by falling back to decompiling everything).
#
# Invoked as: analyzeHeadless <proj> <name> -process <programName> -noanalysis \
#     -scriptPath <relay/ghidra> -postScript decompile_function.py <outfile> <entryHex>
# It reopens the persistent project created by export_analysis.py (no re-import, no re-analysis).
#
# @category web-mv

import json

from ghidra.app.decompiler import DecompInterface
from ghidra.util.task import ConsoleTaskMonitor

MAX_CTEXT = 200000  # bound the pseudocode text
TIMEOUT_SEC = 60

args = getScriptArgs()
outfile = args[0] if len(args) > 0 else "web-mv-ghidra-decompile.json"
entry_str = args[1] if len(args) > 1 else ""


def emit(obj):
    obj["format"] = "web-mv.ghidra.decompile"
    obj["schemaVersion"] = 1
    f = open(outfile, "w")
    try:
        f.write(json.dumps(obj))
    finally:
        f.close()


entry_off = None
try:
    s = entry_str[2:] if entry_str[:2].lower() == "0x" else entry_str
    entry_off = int(s, 16)
except Exception:
    entry_off = None

if entry_off is None:
    emit({"functionEntry": entry_str, "found": False, "error": "invalid function entry", "cText": "", "warnings": ["invalid entry"], "timedOut": False, "truncated": False})
else:
    addr = currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(entry_off)
    func = currentProgram.getFunctionManager().getFunctionAt(addr)
    entry_hex = "0x%x" % entry_off
    if func is None:
        emit({"functionEntry": entry_hex, "found": False, "error": "function not found at entry", "cText": "", "warnings": ["function not found"], "timedOut": False, "truncated": False})
    else:
        decomp = DecompInterface()
        decomp.openProgram(currentProgram)
        monitor = ConsoleTaskMonitor()
        ctext = ""
        timed_out = False
        warnings = []
        try:
            res = decomp.decompileFunction(func, TIMEOUT_SEC, monitor)
            if res is not None and res.decompileCompleted():
                ctext = res.getDecompiledFunction().getC()
            else:
                timed_out = True
                warnings.append("decompiler did not complete")
        except Exception as e:
            warnings.append("decompiler error: %s" % str(e))
        truncated = False
        if len(ctext) > MAX_CTEXT:
            ctext = ctext[:MAX_CTEXT]
            truncated = True
            warnings.append("pseudocode truncated at %d chars" % MAX_CTEXT)
        try:
            sig = func.getPrototypeString(False, False)
        except Exception:
            sig = None
        try:
            cc = func.getCallingConventionName()
        except Exception:
            cc = None
        emit({
            "functionEntry": entry_hex,
            "functionName": func.getName(),
            "signature": sig,
            "callingConvention": cc,
            "cText": ctext,
            "warnings": warnings,
            "timedOut": timed_out,
            "truncated": truncated,
            "found": True,
        })

print("[web-mv] decompiled %s -> %s" % (entry_str, outfile))
