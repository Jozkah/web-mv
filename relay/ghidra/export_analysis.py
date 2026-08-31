# web-mv Ghidra headless post-script: MODULE METADATA ONLY.
#
# Exports program metadata, memory blocks, function entries (names/ranges/signatures/calling
# conventions), and symbols. It DOES NOT import or invoke the Ghidra decompiler — pseudocode is
# produced only on an explicit, per-function request (decompile_function.py). This keeps a module
# analysis bounded (no thousands of 60-second decompiles).
#
# Invoked as: analyzeHeadless <proj> <name> -import <dump> -loader PeLoader \
#     -scriptPath <relay/ghidra> -postScript export_analysis.py <outfile> \
#     -analysisTimeoutPerFile <sec>
# The project is kept (NOT -deleteProject) so decompile_function.py can reopen it with -process.
#
# @category web-mv

import json

MAX_FUNCS = 20000
MAX_SYMS = 20000

args = getScriptArgs()
outfile = args[0] if len(args) > 0 else "web-mv-ghidra-analysis.json"

try:
    image_base = "0x%x" % currentProgram.getImageBase().getOffset()
except Exception:
    image_base = "0x0"
try:
    arch = currentProgram.getLanguageID().toString()
except Exception:
    arch = None
try:
    compiler = currentProgram.getCompilerSpec().getCompilerSpecID().toString()
except Exception:
    compiler = None

blocks = []
try:
    for b in currentProgram.getMemory().getBlocks():
        blocks.append({
            "name": b.getName(),
            "start": "0x%x" % b.getStart().getOffset(),
            "size": int(b.getSize()),
            "r": bool(b.isRead()),
            "w": bool(b.isWrite()),
            "x": bool(b.isExecute()),
        })
except Exception:
    pass

warnings = []
truncated = False

functions = []
count = 0
try:
    for f in currentProgram.getFunctionManager().getFunctions(True):
        if count >= MAX_FUNCS:
            truncated = True
            warnings.append("function list truncated at %d" % MAX_FUNCS)
            break
        try:
            entry = "0x%x" % f.getEntryPoint().getOffset()
        except Exception:
            continue
        body = f.getBody()
        try:
            sig = f.getPrototypeString(False, False)
        except Exception:
            sig = None
        try:
            cc = f.getCallingConventionName()
        except Exception:
            cc = None
        functions.append({
            "address": entry,
            "name": f.getName(),
            "signature": sig,
            "callingConvention": cc,
            "size": int(body.getNumAddresses()) if body is not None else None,
        })
        count += 1
except Exception as e:
    warnings.append("function enumeration error: %s" % str(e))

symbols = []
scount = 0
try:
    for s in currentProgram.getSymbolTable().getAllSymbols(True):
        if scount >= MAX_SYMS:
            truncated = True
            warnings.append("symbol list truncated at %d" % MAX_SYMS)
            break
        try:
            symbols.append({
                "address": "0x%x" % s.getAddress().getOffset(),
                "name": s.getName(),
                "type": s.getSymbolType().toString(),
            })
        except Exception:
            continue
        scount += 1
except Exception as e:
    warnings.append("symbol enumeration error: %s" % str(e))

out = {
    "format": "web-mv.ghidra.analysis",
    "schemaVersion": 1,
    "imageBase": image_base,
    "arch": arch,
    "compiler": compiler,
    "blocks": blocks,
    "functions": functions,
    "symbols": symbols,
    "warnings": warnings,
    "truncated": truncated,
}

f = open(outfile, "w")
try:
    f.write(json.dumps(out))
finally:
    f.close()

print("[web-mv] analysis: %d functions, %d symbols -> %s" % (len(functions), len(symbols), outfile))
