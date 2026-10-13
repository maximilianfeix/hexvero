// Ghidra headless export used by hexvero. Arguments: <operation> <address|text:needle|-> <outputPath>
// Operations: functions, decompile, xrefs, callers, callees, callgraph, search.
// Writes one JSON document; never modifies the program. Nodes and edges are keyed by entry address
// because function names are not unique (overloads, methods of different classes).
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.DataIterator;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.Symbol;
import ghidra.program.model.symbol.SymbolIterator;
import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

public class HexveroExport extends GhidraScript {
  private static final int MAX_FUNCTIONS = 50000;
  private static final int MAX_REFERENCES = 20000;
  private static final int MAX_EDGES = 200000;
  private static final int MAX_SEARCH_RESULTS = 5000;
  private static final int MAX_STRING_VALUE = 256;

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

  private static String addr(Address a) {
    return a == null ? null : a.toString();
  }

  private Address parseAddress(String spec) {
    try {
      return currentProgram.getAddressFactory().getAddress(spec);
    } catch (Exception ignored) {
      return null;
    }
  }

  private Function resolve(String spec) {
    if (spec == null || spec.equals("-")) return null;
    Address addr = parseAddress(spec);
    if (addr != null) {
      Function f = getFunctionContaining(addr);
      if (f != null) return f;
    }
    SymbolIterator it = currentProgram.getSymbolTable().getSymbols(spec);
    while (it.hasNext()) {
      Symbol s = it.next();
      Function f = getFunctionAt(s.getAddress());
      if (f != null) return f;
    }
    return null;
  }

  /** Every address a symbol name or address spec denotes (functions and data alike). */
  private List<Address> resolveAddresses(String spec) {
    List<Address> out = new ArrayList<>();
    Address addr = parseAddress(spec);
    if (addr != null && currentProgram.getMemory().contains(addr)) {
      out.add(addr);
      return out;
    }
    Set<Address> seen = new LinkedHashSet<>();
    SymbolIterator it = currentProgram.getSymbolTable().getSymbols(spec);
    while (it.hasNext()) seen.add(it.next().getAddress());
    out.addAll(seen);
    return out;
  }

  private String node(Function f) {
    return "{\"name\":" + q(f.getName()) + ",\"address\":" + q(addr(f.getEntryPoint())) + ",\"size\":" + f.getBody().getNumAddresses() + ",\"external\":" + f.isExternal() + ",\"thunk\":" + f.isThunk() + "}";
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
        while (fs.hasNext() && count < MAX_FUNCTIONS) {
          Function f = fs.next();
          if (!first) out.print(",");
          first = false;
          count++;
          out.print("{\"name\":" + q(f.getName()) + ",\"address\":" + q(addr(f.getEntryPoint())) + ",\"size\":" + f.getBody().getNumAddresses() + ",\"external\":" + f.isExternal() + ",\"thunk\":" + f.isThunk() + ",\"signature\":" + q(f.getPrototypeString(false, false)) + "}");
        }
        out.print("],\"truncated\":" + fs.hasNext() + "}");
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
        out.print("{\"name\":" + q(f.getName()) + ",\"address\":" + q(addr(f.getEntryPoint())) + ",\"signature\":" + q(f.getPrototypeString(false, false)) + ",\"code\":" + q(code) + ",\"completed\":" + res.decompileCompleted() + ",\"message\":" + q(res.getErrorMessage()) + "}");
        decomp.dispose();
      } else if (operation.equals("xrefs")) {
        List<Address> targets = resolveAddresses(spec);
        if (targets.isEmpty()) {
          out.print("{\"error\":\"address not found\",\"address\":" + q(spec) + ",\"references\":[],\"truncated\":false}");
          return;
        }
        if (targets.size() > 1) {
          StringBuilder c = new StringBuilder();
          for (Address t : targets) {
            if (c.length() > 0) c.append(",");
            c.append(q(addr(t)));
          }
          out.print("{\"error\":\"ambiguous symbol\",\"address\":" + q(spec) + ",\"candidates\":[" + c + "],\"references\":[],\"truncated\":false}");
          return;
        }
        Address target = targets.get(0);
        out.print("{\"address\":" + q(addr(target)) + ",\"references\":[");
        boolean first = true;
        int count = 0;
        boolean truncated = false;
        for (Reference ref : currentProgram.getReferenceManager().getReferencesTo(target)) {
          if (ref.isEntryPointReference()) continue;
          if (count >= MAX_REFERENCES) { truncated = true; break; }
          count++;
          if (!first) out.print(",");
          first = false;
          Function from = getFunctionContaining(ref.getFromAddress());
          out.print("{\"from\":" + q(addr(ref.getFromAddress())) + ",\"type\":" + q(ref.getReferenceType().getName()) + ",\"function\":" + q(from == null ? null : from.getName()) + ",\"functionAddress\":" + q(from == null ? null : addr(from.getEntryPoint())) + "}");
        }
        out.print("],\"truncated\":" + truncated + "}");
      } else if (operation.equals("callgraph")) {
        // Nodes and edges carry entry addresses; the edge budget is global and reported separately.
        out.print("{\"nodes\":[");
        FunctionIterator fs = currentProgram.getFunctionManager().getFunctions(true);
        boolean first = true;
        int count = 0;
        int edgeCount = 0;
        boolean edgesTruncated = false;
        StringBuilder edges = new StringBuilder();
        while (fs.hasNext() && count < MAX_FUNCTIONS) {
          Function f = fs.next();
          if (!first) out.print(",");
          first = false;
          count++;
          out.print(node(f));
          if (edgesTruncated) continue;
          for (Function g : f.getCalledFunctions(monitor)) {
            if (edgeCount >= MAX_EDGES) { edgesTruncated = true; break; }
            edgeCount++;
            if (edges.length() > 0) edges.append(",");
            edges.append("{\"from\":" + q(addr(f.getEntryPoint())) + ",\"to\":" + q(addr(g.getEntryPoint())) + ",\"toName\":" + q(g.getName()) + "}");
          }
        }
        out.print("],\"edges\":[" + edges + "],\"truncated\":" + fs.hasNext() + ",\"edgesTruncated\":" + edgesTruncated + "}");
      } else if (operation.equals("search")) {
        String needle = spec.startsWith("text:") ? spec.substring(5).toLowerCase() : "";
        int budget = MAX_SEARCH_RESULTS;
        boolean truncated = false;
        out.print("{\"needle\":" + q(needle) + ",\"functions\":[");
        FunctionIterator fs = currentProgram.getFunctionManager().getFunctions(true);
        boolean first = true;
        while (fs.hasNext()) {
          Function f = fs.next();
          if (!f.getName().toLowerCase().contains(needle)) continue;
          if (budget <= 0) { truncated = true; break; }
          budget--;
          if (!first) out.print(",");
          first = false;
          out.print("{\"name\":" + q(f.getName()) + ",\"address\":" + q(addr(f.getEntryPoint())) + "}");
        }
        out.print("],\"strings\":[");
        first = true;
        DataIterator data = currentProgram.getListing().getDefinedData(true);
        while (data.hasNext() && !truncated) {
          Data d = data.next();
          if (!d.hasStringValue()) continue;
          Object v = d.getValue();
          String text = v == null ? "" : v.toString();
          if (!text.toLowerCase().contains(needle)) continue;
          if (budget <= 0) { truncated = true; break; }
          budget--;
          if (!first) out.print(",");
          first = false;
          String value = text.length() > MAX_STRING_VALUE ? text.substring(0, MAX_STRING_VALUE) : text;
          out.print("{\"value\":" + q(value) + ",\"address\":" + q(addr(d.getAddress())) + ",\"length\":" + text.length() + "}");
        }
        out.print("],\"truncated\":" + truncated + "}");
      } else {
        out.print("{\"error\":\"unknown operation\",\"operation\":" + q(operation) + "}");
      }
    }
  }
}
