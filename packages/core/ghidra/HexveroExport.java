// Ghidra headless export used by hexvero. Arguments: <operation> <address|-> <outputPath>
// Operations: functions, decompile. Writes a JSON document; never modifies the program.
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.symbol.Symbol;
import ghidra.program.model.symbol.SymbolIterator;
import java.io.FileWriter;
import java.io.PrintWriter;

public class HexveroExport extends GhidraScript {
  private static String q(String s) {
    if (s == null) return "null";
    StringBuilder b = new StringBuilder("\"");
    for (char c : s.toCharArray()) {
      switch (c) {
        case '"': b.append("\\\""); break;
        case '\\': b.append("\\\\"); break;
        case '\n': b.append("\\n"); break;
        case '\r': b.append("\\r"); break;
        case '\t': b.append("\\t"); break;
        default:
          if (c < 0x20) b.append(String.format("\\u%04x", (int) c)); else b.append(c);
      }
    }
    return b.append('"').toString();
  }

  private Function resolve(String spec) {
    if (spec == null || spec.equals("-")) return null;
    try {
      Address addr = currentProgram.getAddressFactory().getAddress(spec);
      if (addr != null) {
        Function f = getFunctionContaining(addr);
        if (f != null) return f;
      }
    } catch (Exception ignored) {}
    SymbolIterator it = currentProgram.getSymbolTable().getSymbols(spec);
    while (it.hasNext()) {
      Symbol s = it.next();
      Function f = getFunctionAt(s.getAddress());
      if (f != null) return f;
    }
    return null;
  }

  @Override
  public void run() throws Exception {
    String[] args = getScriptArgs();
    String operation = args.length > 0 ? args[0] : "functions";
    String spec = args.length > 1 ? args[1] : "-";
    String output = args.length > 2 ? args[2] : "hexvero-export.json";
    try (PrintWriter out = new PrintWriter(new FileWriter(output))) {
      if (operation.equals("functions")) {
        out.print("{\"program\":" + q(currentProgram.getName()) + ",\"language\":" + q(currentProgram.getLanguageID().getIdAsString()) + ",\"functions\":[");
        FunctionIterator fs = currentProgram.getFunctionManager().getFunctions(true);
        boolean first = true;
        int count = 0;
        while (fs.hasNext() && count < 50000) {
          Function f = fs.next();
          if (!first) out.print(",");
          first = false;
          count++;
          out.print("{\"name\":" + q(f.getName()) + ",\"address\":" + q("0x" + f.getEntryPoint().toString()) + ",\"size\":" + f.getBody().getNumAddresses() + ",\"external\":" + f.isExternal() + ",\"thunk\":" + f.isThunk() + ",\"signature\":" + q(f.getPrototypeString(false, false)) + "}");
        }
        out.print("],\"truncated\":" + (fs.hasNext()) + "}");
      } else if (operation.equals("decompile")) {
        Function f = resolve(spec);
        if (f == null) {
          out.print("{\"error\":\"function not found\",\"address\":" + q(spec) + "}");
          return;
        }
        DecompInterface decomp = new DecompInterface();
        decomp.openProgram(currentProgram);
        DecompileResults res = decomp.decompileFunction(f, 120, monitor);
        String code = res.decompileCompleted() ? res.getDecompiledFunction().getC() : null;
        out.print("{\"name\":" + q(f.getName()) + ",\"address\":" + q("0x" + f.getEntryPoint().toString()) + ",\"signature\":" + q(f.getPrototypeString(false, false)) + ",\"code\":" + q(code) + ",\"completed\":" + res.decompileCompleted() + ",\"message\":" + q(res.getErrorMessage()) + "}");
        decomp.dispose();
      } else {
        out.print("{\"error\":\"unknown operation\",\"operation\":" + q(operation) + "}");
      }
    }
  }
}
