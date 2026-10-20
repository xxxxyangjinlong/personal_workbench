import java.io.*;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.sql.*;
import java.util.*;

/**
 * Persistent JDBC bridge. Speaks a length-prefixed JSON line protocol on
 * stdin/stdout so a single JVM (and a single DB connection) can serve many
 * queries. Keeps the driver set uniform: any JDBC driver on the classpath works.
 *
 * Request  <len>\n<payload bytes>
 * Response <len>\n<payload bytes>
 *
 * Actions: connect | query | tables | columns | close | ping
 */
public class JdbcBridge {

    static Connection conn = null;

    public static void main(String[] args) throws Exception {
        InputStream in = System.in;
        OutputStream out = System.out;
        DriverManager.setLoginTimeout(12);
        try { Class.forName("com.mysql.cj.jdbc.Driver"); } catch (Throwable ignore) {}

        while (true) {
            byte[] payload = readFrame(in);
            if (payload == null) break;
            Map<String, Object> req;
            try {
                req = Json.parseObject(new String(payload, StandardCharsets.UTF_8));
            } catch (Exception e) {
                writeFrame(out, Json.write(err("bad-request", e)));
                continue;
            }
            Map<String, Object> resp;
            try {
                resp = handle(req);
            } catch (Throwable t) {
                resp = err(t.getClass().getSimpleName(), t);
            }
            writeFrame(out, Json.write(resp));
        }
        try { if (conn != null) conn.close(); } catch (Exception ignore) {}
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> handle(Map<String, Object> req) throws Exception {
        String action = str(req.get("action"));
        Map<String, Object> r = new LinkedHashMap<>();
        if ("ping".equals(action)) {
            r.put("ok", true);
            return r;
        }
        if ("connect".equals(action)) {
            if (conn != null) { try { conn.close(); } catch (Exception ignore) {} conn = null; }
            String url = str(req.get("url"));
            String driver = str(req.get("driver"));
            if (driver != null && !driver.isEmpty()) {
                try { Class.forName(driver); } catch (Throwable ignore) {}
            }
            Properties p = new Properties();
            if (req.get("user") != null) p.put("user", str(req.get("user")));
            if (req.get("password") != null) p.put("password", str(req.get("password")));
            long t0 = System.currentTimeMillis();
            conn = DriverManager.getConnection(url, p);
            r.put("ok", true);
            r.put("elapsedMs", System.currentTimeMillis() - t0);
            DatabaseMetaData md = conn.getMetaData();
            r.put("product", md.getDatabaseProductName());
            r.put("version", md.getDatabaseProductVersion());
            r.put("driverName", md.getDriverName());
            r.put("catalog", conn.getCatalog());
            r.put("schema", currentSchema());
            return r;
        }
        if ("info".equals(action)) {
            if (conn == null) throw new SQLException("未连接");
            DatabaseMetaData md = conn.getMetaData();
            r.put("ok", true);
            r.put("product", md.getDatabaseProductName());
            r.put("version", md.getDatabaseProductVersion());
            r.put("driverName", md.getDriverName());
            r.put("catalog", conn.getCatalog());
            r.put("schema", currentSchema());
            return r;
        }
        if (conn == null) throw new SQLException("未连接数据库，请先 connect");
        if ("query".equals(action)) {
            String sql = str(req.get("sql"));
            int maxRows = req.get("maxRows") != null ? ((Number) req.get("maxRows")).intValue() : 200;
            Statement st = conn.createStatement();
            try {
                st.setMaxRows(maxRows);
                st.setQueryTimeout(0);
                long t0 = System.currentTimeMillis();
                boolean has = st.execute(sql);
                r.put("elapsedMs", System.currentTimeMillis() - t0);
                if (has) {
                    ResultSet rs = st.getResultSet();
                    ResultSetMetaData m = rs.getMetaData();
                    int n = m.getColumnCount();
                    List<Object> cols = new ArrayList<>();
                    for (int i = 1; i <= n; i++) cols.add(m.getColumnLabel(i));
                    List<Object> rows = new ArrayList<>();
                    while (rs.next()) {
                        List<Object> row = new ArrayList<>();
                        for (int i = 1; i <= n; i++) {
                            Object v = rs.getObject(i);
                            if (v == null) row.add(null);
                            else if (v instanceof byte[]) row.add("<binary " + ((byte[]) v).length + " bytes>");
                            else if (v instanceof java.sql.Clob) row.add(clobToString((Clob) v));
                            else row.add(String.valueOf(v));
                        }
                        rows.add(row);
                    }
                    rs.close();
                    r.put("ok", true);
                    r.put("columns", cols);
                    r.put("rows", rows);
                    r.put("rowCount", rows.size());
                } else {
                    r.put("ok", true);
                    r.put("columns", new ArrayList<>());
                    r.put("rows", new ArrayList<>());
                    r.put("rowCount", 0);
                    r.put("updateCount", st.getUpdateCount());
                }
                return r;
            } finally { try { st.close(); } catch (Exception ignore) {} }
        }
        if ("schemas".equals(action)) {
            List<Object> out = new ArrayList<>();
            DatabaseMetaData md = conn.getMetaData();
            try (ResultSet rs = md.getSchemas()) {
                while (rs.next()) out.add(rs.getString("TABLE_SCHEM"));
            } catch (Throwable t) {
                try (ResultSet rs = md.getSchemas(null, null)) {
                    while (rs.next()) out.add(rs.getString("TABLE_SCHEM"));
                } catch (Throwable ignore) {}
            }
            r.put("ok", true);
            r.put("schemas", out);
            return r;
        }
        if ("tables".equals(action)) {
            String reqSchema = str(req.get("schema"));
            String schema = (reqSchema != null && !reqSchema.isEmpty()) ? reqSchema : currentSchema();
            String catalog = conn.getCatalog();
            List<String> names = listTables(catalog, schema);
            if (names.isEmpty() && schema != null && !schema.isEmpty()) {
                names = listTables(catalog, schema.toUpperCase());
                if (names.isEmpty()) names = listTables(catalog, schema.toLowerCase());
            }
            if (names.isEmpty()) names = listTables(catalog, null);
            r.put("ok", true);
            r.put("schema", schema);
            r.put("tables", new ArrayList<Object>(names));
            return r;
        }
        if ("columns".equals(action)) {
            String table = str(req.get("table"));
            String reqSchema = str(req.get("schema"));
            String schema = (reqSchema != null && !reqSchema.isEmpty()) ? reqSchema : currentSchema();
            String catalog = conn.getCatalog();
            List<Object> cols = listColumns(catalog, schema, table);
            if (cols.isEmpty()) cols = listColumns(catalog, schema, table.toUpperCase());
            if (cols.isEmpty()) cols = listColumns(catalog, schema, table.toLowerCase());
            if (cols.isEmpty() && schema != null) cols = listColumns(catalog, null, table);
            r.put("ok", true);
            r.put("columns", cols);
            return r;
        }
        if ("close".equals(action)) {
            if (conn != null) { conn.close(); conn = null; }
            r.put("ok", true);
            return r;
        }
        throw new SQLException("未知 action: " + action);
    }

    static List<String> listTables(String catalog, String schema) throws SQLException {
        List<String> out = new ArrayList<>();
        DatabaseMetaData md = conn.getMetaData();
        try (ResultSet rs = md.getTables(catalog, schema, "%", new String[]{"TABLE", "VIEW"})) {
            while (rs.next()) {
                String n = rs.getString("TABLE_NAME");
                if (n != null && !out.contains(n)) out.add(n);
            }
        }
        Collections.sort(out);
        return out;
    }

    static List<Object> listColumns(String catalog, String schema, String table) throws SQLException {
        List<Object> out = new ArrayList<>();
        DatabaseMetaData md = conn.getMetaData();
        try (ResultSet rs = md.getColumns(catalog, schema, table, "%")) {
            while (rs.next()) {
                Map<String, Object> col = new LinkedHashMap<>();
                col.put("name", rs.getString("COLUMN_NAME"));
                col.put("type", rs.getString("TYPE_NAME"));
                col.put("size", rs.getInt("COLUMN_SIZE"));
                col.put("nullable", rs.getInt("NULLABLE") == DatabaseMetaData.columnNullable);
                out.add(col);
            }
        }
        return out;
    }

    static String currentSchema() {
        try { return conn.getSchema(); } catch (Throwable ignore) { return null; }
    }

    static String clobToString(Clob c) {
        try {
            long len = Math.min(c.length(), 2000);
            return c.getSubString(1, (int) len);
        } catch (Exception e) { return "<clob>"; }
    }

    static Map<String, Object> err(String kind, Throwable t) {
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("ok", false);
        r.put("errorKind", kind);
        r.put("error", t.getMessage() == null ? t.toString() : t.getMessage());
        return r;
    }

    static String str(Object o) { return o == null ? null : String.valueOf(o); }

    // ---- framing ----
    static byte[] readFrame(InputStream in) throws IOException {
        int b;
        StringBuilder sb = new StringBuilder();
        while ((b = in.read()) != -1) {
            if (b == '\n') break;
            if (b != '\r') sb.append((char) b);
        }
        if (sb.length() == 0) return null;
        int len = Integer.parseInt(sb.toString().trim());
        byte[] buf = new byte[len];
        int read = 0;
        while (read < len) {
            int r = in.read(buf, read, len - read);
            if (r < 0) break;
            read += r;
        }
        return buf;
    }

    static void writeFrame(OutputStream out, String s) throws IOException {
        byte[] bytes = s.getBytes(StandardCharsets.UTF_8);
        out.write((Integer.toString(bytes.length) + "\n").getBytes(StandardCharsets.US_ASCII));
        out.write(bytes);
        out.flush();
    }

    // ---- tiny JSON ----
    static class Json {
        private final String s; private int i; private final int n;
        Json(String s) { this.s = s; this.n = s.length(); }

        static Map<String, Object> parseObject(String s) {
            Json j = new Json(s);
            j.ws();
            Object v = j.value();
            if (!(v instanceof Map)) throw new RuntimeException("expected object");
            @SuppressWarnings("unchecked") Map<String, Object> m = (Map<String, Object>) v;
            return m;
        }

        void ws() { while (i < n && Character.isWhitespace(s.charAt(i))) i++; }

        Object value() {
            ws();
            if (i >= n) throw new RuntimeException("eof");
            char c = s.charAt(i);
            switch (c) {
                case '{': return obj();
                case '[': return arr();
                case '"': return strv();
                case 't': expect("true"); return Boolean.TRUE;
                case 'f': expect("false"); return Boolean.FALSE;
                case 'n': expect("null"); return null;
                default: return num();
            }
        }

        void expect(String w) { if (!s.startsWith(w, i)) throw new RuntimeException("bad token"); i += w.length(); }

        Map<String, Object> obj() {
            Map<String, Object> m = new LinkedHashMap<>();
            i++; ws();
            if (i < n && s.charAt(i) == '}') { i++; return m; }
            while (true) {
                ws();
                String k = strv();
                ws(); if (s.charAt(i) != ':') throw new RuntimeException("expected :"); i++;
                Object v = value();
                m.put(k, v);
                ws();
                char c = s.charAt(i++);
                if (c == ',') continue;
                if (c == '}') break;
                throw new RuntimeException("bad object");
            }
            return m;
        }

        List<Object> arr() {
            List<Object> l = new ArrayList<>();
            i++; ws();
            if (i < n && s.charAt(i) == ']') { i++; return l; }
            while (true) {
                l.add(value());
                ws();
                char c = s.charAt(i++);
                if (c == ',') continue;
                if (c == ']') break;
                throw new RuntimeException("bad array");
            }
            return l;
        }

        String strv() {
            if (s.charAt(i) != '"') throw new RuntimeException("expected string");
            i++;
            StringBuilder sb = new StringBuilder();
            while (i < n) {
                char c = s.charAt(i++);
                if (c == '"') return sb.toString();
                if (c == '\\') {
                    char e = s.charAt(i++);
                    switch (e) {
                        case '"': sb.append('"'); break;
                        case '\\': sb.append('\\'); break;
                        case '/': sb.append('/'); break;
                        case 'b': sb.append('\b'); break;
                        case 'f': sb.append('\f'); break;
                        case 'n': sb.append('\n'); break;
                        case 'r': sb.append('\r'); break;
                        case 't': sb.append('\t'); break;
                        case 'u':
                            sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                            i += 4; break;
                        default: sb.append(e);
                    }
                } else sb.append(c);
            }
            throw new RuntimeException("unterminated string");
        }

        Object num() {
            int start = i;
            while (i < n && "+-.eE0123456789".indexOf(s.charAt(i)) >= 0) i++;
            String t = s.substring(start, i);
            if (t.indexOf('.') >= 0 || t.indexOf('e') >= 0 || t.indexOf('E') >= 0)
                return Double.parseDouble(t);
            try { return Long.parseLong(t); } catch (NumberFormatException e) { return new BigDecimal(t); }
        }

        static String write(Object o) {
            StringBuilder sb = new StringBuilder();
            writeVal(sb, o);
            return sb.toString();
        }

        @SuppressWarnings("unchecked")
        static void writeVal(StringBuilder sb, Object o) {
            if (o == null) { sb.append("null"); return; }
            if (o instanceof String) { writeStr(sb, (String) o); return; }
            if (o instanceof Map) {
                sb.append('{');
                boolean first = true;
                for (Map.Entry<String, Object> e : ((Map<String, Object>) o).entrySet()) {
                    if (!first) sb.append(','); first = false;
                    writeStr(sb, e.getKey()); sb.append(':'); writeVal(sb, e.getValue());
                }
                sb.append('}');
                return;
            }
            if (o instanceof List) {
                sb.append('[');
                boolean first = true;
                for (Object v : (List<Object>) o) {
                    if (!first) sb.append(','); first = false;
                    writeVal(sb, v);
                }
                sb.append(']');
                return;
            }
            if (o instanceof Boolean) { sb.append(o.toString()); return; }
            writeStr(sb, String.valueOf(o));
        }

        static void writeStr(StringBuilder sb, String s) {
            sb.append('"');
            for (int k = 0; k < s.length(); k++) {
                char c = s.charAt(k);
                switch (c) {
                    case '"': sb.append("\\\""); break;
                    case '\\': sb.append("\\\\"); break;
                    case '\n': sb.append("\\n"); break;
                    case '\r': sb.append("\\r"); break;
                    case '\t': sb.append("\\t"); break;
                    case '\b': sb.append("\\b"); break;
                    case '\f': sb.append("\\f"); break;
                    default:
                        if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                        else sb.append(c);
                }
            }
            sb.append('"');
        }
    }
}
