// host.cs — ACE Music 批量下載器「本機整理工具」native messaging host（C# / .NET Framework 4.x）
// 功能：移動/改名已下載的檔案（只在 Downloads 目錄內），列出目錄內容供擴充功能比對。
// 協定：4-byte little-endian 長度 + UTF-8 JSON（Chrome native messaging）。
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

internal static class Program
{
    private const string VERSION = "1.1.0";
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
    private static readonly string DownloadsRoot =
        Path.GetFullPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads"));

    private static void Main()
    {
        Stream input = Console.OpenStandardInput();
        Stream output = Console.OpenStandardOutput();
        byte[] lenBuf = new byte[4];
        while (true)
        {
            if (!ReadExactly(input, lenBuf, 4)) break;
            int len = BitConverter.ToInt32(lenBuf, 0);
            if (len <= 0 || len > 64 * 1024 * 1024) break;
            byte[] body = new byte[len];
            if (!ReadExactly(input, body, len)) break;
            string raw;
            try { raw = Encoding.UTF8.GetString(body); }
            catch { break; }
            Dictionary<string, object> response;
            try
            {
                var request = Json.DeserializeObject(raw) as Dictionary<string, object>;
                response = Handle(request);
                // 回傳原 reqId，讓擴充功能的 request/response 對得上
                if (request != null && request.ContainsKey("reqId"))
                {
                    response["reqId"] = request["reqId"];
                }
            }
            catch (Exception ex)
            {
                response = Error(ex.Message);
            }
            byte[] payload = Encoding.UTF8.GetBytes(Json.Serialize(response));
            byte[] outLen = BitConverter.GetBytes(payload.Length);
            output.Write(outLen, 0, 4);
            output.Write(payload, 0, payload.Length);
            output.Flush();
        }
    }

    private static bool ReadExactly(Stream stream, byte[] buffer, int count)
    {
        int offset = 0;
        while (offset < count)
        {
            int read = stream.Read(buffer, offset, count - offset);
            if (read <= 0) return false;
            offset += read;
        }
        return true;
    }

    private static Dictionary<string, object> Handle(Dictionary<string, object> request)
    {
        try
        {
            if (request == null) return Error("empty request");
            string cmd = request.ContainsKey("cmd") ? Convert.ToString(request["cmd"]) : "";
            switch (cmd)
            {
                case "ping": return Ping();
                case "move": return Move(request);
                case "list": return List(request);
                case "export": return Export(request);
                case "read": return ReadExport(request);
                case "organize": return RunOrganize(request);
                case "tidy": return RunCli("tidy-all --background --json", 30000, "一鍵整理");
                case "dedupe-custom": return RunCli("dedupe-content --commit --include-custom --json", 120000, "清理自訂重複");
                case "extract-mp3": return RunCli("extract-mp3 --background --json", 30000, "成品 MP3");
                case "watch": return RunCli("watch --background --json", 30000, "背景整理");
                case "open": return OpenFolder(request);
                default: return Error("unknown cmd: " + cmd);
            }
        }
        catch (Exception ex)
        {
            return Error(ex.Message);
        }
    }

    private static Dictionary<string, object> Ping()
    {
        var result = new Dictionary<string, object>();
        result["ok"] = true;
        result["version"] = VERSION;
        result["downloadsRoot"] = DownloadsRoot;
        return result;
    }

    private static bool UnderDownloads(string fullPath)
    {
        string root = DownloadsRoot.TrimEnd('\\', '/') + Path.DirectorySeparatorChar;
        return fullPath.StartsWith(root, StringComparison.OrdinalIgnoreCase);
    }

    private static Dictionary<string, object> Move(Dictionary<string, object> request)
    {
        var moved = new List<object>();
        var deduped = new List<object>();
        var failed = new List<object>();
        var missing = new List<object>();

        var moves = request.ContainsKey("moves") ? request["moves"] as object[] : null;
        if (moves == null) return Error("moves missing");
        if (moves.Length > 2000) return Error("too many moves (" + moves.Length + ")");

        foreach (object item in moves)
        {
            var entry = item as Dictionary<string, object>;
            if (entry == null) continue;
            try
            {
                string from = Path.GetFullPath(Convert.ToString(entry["from"]));
                string to = Path.GetFullPath(Convert.ToString(entry["to"]));
                if (!UnderDownloads(from) || !UnderDownloads(to))
                {
                    failed.Add(new Dictionary<string, object> { { "from", from }, { "to", to }, { "error", "只允許在 Downloads 目錄內移動" } });
                    continue;
                }
                if (string.Equals(from, to, StringComparison.OrdinalIgnoreCase))
                {
                    deduped.Add(new Dictionary<string, object> { { "from", from }, { "to", to }, { "note", "already" } });
                    continue;
                }
                if (!File.Exists(from))
                {
                    missing.Add(new Dictionary<string, object> { { "from", from } });
                    continue;
                }
                Directory.CreateDirectory(Path.GetDirectoryName(to));
                string target = to;
                if (File.Exists(target))
                {
                    long a = new FileInfo(from).Length;
                    long b = new FileInfo(target).Length;
                    if (a == b)
                    {
                        File.Delete(from);
                        deduped.Add(new Dictionary<string, object> { { "from", from }, { "to", target }, { "note", "duplicate-removed" } });
                        continue;
                    }
                    target = UniquePath(target);
                }
                try
                {
                    File.Move(from, target);
                }
                catch (IOException)
                {
                    File.Copy(from, target, true);
                    File.Delete(from);
                }
                moved.Add(new Dictionary<string, object> { { "from", from }, { "to", target } });
            }
            catch (Exception ex)
            {
                failed.Add(new Dictionary<string, object> { { "error", ex.Message } });
            }
        }

        var result = new Dictionary<string, object>();
        result["ok"] = true;
        result["movedCount"] = moved.Count;
        result["dedupedCount"] = deduped.Count;
        result["missingCount"] = missing.Count;
        result["failedCount"] = failed.Count;
        result["moved"] = moved;
        result["deduped"] = deduped;
        result["missing"] = missing;
        result["failed"] = failed;
        return result;
    }

    private static string UniquePath(string path)
    {
        string dir = Path.GetDirectoryName(path);
        string name = Path.GetFileNameWithoutExtension(path);
        string ext = Path.GetExtension(path);
        for (int i = 2; i < 1000; i++)
        {
            string candidate = Path.Combine(dir, name + " (" + i + ")" + ext);
            if (!File.Exists(candidate)) return candidate;
        }
        return Path.Combine(dir, name + " (" + Guid.NewGuid().ToString("N").Substring(0, 6) + ")" + ext);
    }

    private static Dictionary<string, object> List(Dictionary<string, object> request)
    {
        int maxDepth = request.ContainsKey("maxDepth") ? Convert.ToInt32(request["maxDepth"]) : 2;
        int limit = request.ContainsKey("limit") ? Convert.ToInt32(request["limit"]) : 6000;
        var extensions = new List<string>();
        var rawExt = request.ContainsKey("extensions") ? request["extensions"] as object[] : null;
        if (rawExt != null)
        {
            foreach (object e in rawExt) extensions.Add(Convert.ToString(e).TrimStart('.').ToLowerInvariant());
        }

        var files = new List<object>();
        var dirs = new List<object>();
        Walk(DownloadsRoot, 0, Math.Max(0, maxDepth), extensions, limit, files, dirs);

        var result = new Dictionary<string, object>();
        result["ok"] = true;
        result["root"] = DownloadsRoot;
        result["files"] = files;
        result["dirs"] = dirs;
        result["truncated"] = files.Count >= limit;
        return result;
    }

    private static void Walk(string dir, int depth, int maxDepth, List<string> extensions, int limit,
        List<object> files, List<object> dirs)
    {
        if (files.Count >= limit) return;
        try
        {
            foreach (string path in Directory.EnumerateFiles(dir))
            {
                if (files.Count >= limit) return;
                string ext = Path.GetExtension(path).TrimStart('.').ToLowerInvariant();
                if (extensions.Count > 0 && !extensions.Contains(ext)) continue;
                try
                {
                    var info = new FileInfo(path);
                    files.Add(new Dictionary<string, object> {
                        { "path", path },
                        { "size", info.Length },
                        { "mtime", info.LastWriteTimeUtc.ToString("o") }
                    });
                }
                catch { }
            }
        }
        catch { }

        if (depth >= maxDepth) return;
        try
        {
            foreach (string sub in Directory.EnumerateDirectories(dir))
            {
                if (files.Count >= limit) return;
                dirs.Add(sub);
                Walk(sub, depth + 1, maxDepth, extensions, limit, files, dirs);
            }
        }
        catch { }
    }

    private static readonly string StateDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AceMusicDL");

    // export { name:"session"|"history", data:object } → %LOCALAPPDATA%\AceMusicDL\<name>.json
    private static Dictionary<string, object> Export(Dictionary<string, object> request)
    {
        string name = request.ContainsKey("name") ? Convert.ToString(request["name"]) : "";
        if (!System.Text.RegularExpressions.Regex.IsMatch(name, "^[a-zA-Z0-9_-]{1,40}$"))
            return Error("invalid name");
        if (!request.ContainsKey("data")) return Error("data missing");
        Directory.CreateDirectory(StateDir);
        string path = Path.Combine(StateDir, name + ".json");
        string json = Json.Serialize(request["data"]);
        File.WriteAllText(path, json, new UTF8Encoding(false));
        var result = new Dictionary<string, object>();
        result["ok"] = true;
        result["path"] = path;
        result["bytes"] = new FileInfo(path).Length;
        return result;
    }

    // read { name:"history"|"agent-state" } → %LOCALAPPDATA%\AceMusicDL\<name>.json 的內容
    private static Dictionary<string, object> ReadExport(Dictionary<string, object> request)
    {
        string name = request.ContainsKey("name") ? Convert.ToString(request["name"]) : "";
        if (!System.Text.RegularExpressions.Regex.IsMatch(name, "^[a-zA-Z0-9_-]{1,40}$"))
            return Error("invalid name");
        string path = Path.Combine(StateDir, name + ".json");
        if (!File.Exists(path)) return Error("not found: " + path);
        string raw = File.ReadAllText(path, new UTF8Encoding(false));
        object data;
        try { data = Json.DeserializeObject(raw); }
        catch (Exception ex) { return Error("invalid json: " + ex.Message); }
        var result = new Dictionary<string, object>();
        result["ok"] = true;
        result["path"] = path;
        result["data"] = data;
        return result;
    }

    private static string FindNode()
    {
        string[] candidates = {
            @"C:\Program Files\nodejs\node.exe",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs", "node.exe"),
        };
        foreach (string candidate in candidates)
        {
            if (File.Exists(candidate)) return candidate;
        }
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string dir in path.Split(';'))
        {
            try
            {
                string candidate = Path.Combine(dir.Trim(), "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch { }
        }
        return null;
    }

    // organize { commit:false } → 執行 %LOCALAPPDATA%\AceMusicDL\agent\cli.mjs organize --json [--commit]
    private static Dictionary<string, object> RunOrganize(Dictionary<string, object> request)
    {
        string node = FindNode();
        if (node == null) return Error("找不到 node.exe，CLI 需要 Node.js");
        string script = Path.Combine(StateDir, "agent", "cli.mjs");
        if (!File.Exists(script)) return Error("找不到 CLI：" + script + "（請重跑 native\\install-host.ps1）");
        bool commit = request.ContainsKey("commit") && Convert.ToBoolean(request["commit"]);
        var psi = new ProcessStartInfo(node);
        psi.UseShellExecute = false;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.CreateNoWindow = true;
        psi.WorkingDirectory = StateDir;
        psi.StandardOutputEncoding = new UTF8Encoding(false);
        psi.StandardErrorEncoding = new UTF8Encoding(false);
        psi.Arguments = "\"" + script + "\" organize --json" + (commit ? " --commit" : "");
        try
        {
            using (Process proc = Process.Start(psi))
            {
                var stdoutTask = proc.StandardOutput.ReadToEndAsync();
                var stderrTask = proc.StandardError.ReadToEndAsync();
                if (!proc.WaitForExit(190000))
                {
                    try { proc.Kill(); } catch { }
                    return Error("整理逾時（超過 190 秒）");
                }
                string stdout = stdoutTask.Result;
                string stderr = stderrTask.Result;
                object data = null;
                try { data = Json.DeserializeObject(stdout); }
                catch { }
                var result = new Dictionary<string, object>();
                result["ok"] = true;
                result["exitCode"] = proc.ExitCode;
                result["data"] = data;
                result["stderr"] = stderr.Length > 4000 ? stderr.Substring(0, 4000) : stderr;
                return result;
            }
        }
        catch (Exception ex)
        {
            return Error("整理執行失敗：" + ex.Message);
        }
    }

    // 執行 CLI（可帶參數、指定逾時）；目前的用途都是 --background，會立刻回傳 job 資訊
    private static Dictionary<string, object> RunCli(string arguments, int timeoutMs, string label)
    {
        string node = FindNode();
        if (node == null) return Error("找不到 node.exe，CLI 需要 Node.js");
        string script = Path.Combine(StateDir, "agent", "cli.mjs");
        if (!File.Exists(script)) return Error("找不到 CLI：" + script + "（請重跑 native\\install-host.ps1）");
        var psi = new ProcessStartInfo(node);
        psi.UseShellExecute = false;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.CreateNoWindow = true;
        psi.WorkingDirectory = StateDir;
        psi.StandardOutputEncoding = new UTF8Encoding(false);
        psi.StandardErrorEncoding = new UTF8Encoding(false);
        psi.Arguments = "\"" + script + "\" " + arguments;
        try
        {
            using (Process proc = Process.Start(psi))
            {
                var stdoutTask = proc.StandardOutput.ReadToEndAsync();
                var stderrTask = proc.StandardError.ReadToEndAsync();
                if (!proc.WaitForExit(timeoutMs))
                {
                    try { proc.Kill(); } catch { }
                    return Error(label + "逾時");
                }
                string stdout = stdoutTask.Result;
                string stderr = stderrTask.Result;
                object data = null;
                try { data = Json.DeserializeObject(stdout); }
                catch { }
                var result = new Dictionary<string, object>();
                result["ok"] = true;
                result["exitCode"] = proc.ExitCode;
                result["data"] = data;
                result["stderr"] = stderr.Length > 4000 ? stderr.Substring(0, 4000) : stderr;
                return result;
            }
        }
        catch (Exception ex)
        {
            return Error(label + "執行失敗：" + ex.Message);
        }
    }

    // open { folder:"ai音樂/音頻分類" } → 用檔案總管打開 Downloads 內的資料夾（只允許 Downloads 內）
    private static Dictionary<string, object> OpenFolder(Dictionary<string, object> request)
    {
        string folder = request.ContainsKey("folder") ? Convert.ToString(request["folder"]) : "";
        if (string.IsNullOrWhiteSpace(folder)) return Error("缺少 folder");
        string target;
        try
        {
            target = Path.GetFullPath(Path.Combine(DownloadsRoot, folder.Replace('/', Path.DirectorySeparatorChar)));
        }
        catch (Exception ex)
        {
            return Error("路徑不合法：" + ex.Message);
        }
        string rootFull = Path.GetFullPath(DownloadsRoot);
        if (!target.Equals(rootFull, StringComparison.OrdinalIgnoreCase) &&
            !target.StartsWith(rootFull + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
        {
            return Error("只能開啟 Downloads 內的資料夾");
        }
        if (!Directory.Exists(target)) return Error("資料夾不存在：" + target);
        try
        {
            Process.Start(new ProcessStartInfo("explorer.exe", "\"" + target + "\"") { UseShellExecute = true });
            var result = new Dictionary<string, object>();
            result["ok"] = true;
            result["path"] = target;
            return result;
        }
        catch (Exception ex)
        {
            return Error("開啟資料夾失敗：" + ex.Message);
        }
    }

    private static Dictionary<string, object> Error(string message)
    {
        var result = new Dictionary<string, object>();
        result["ok"] = false;
        result["error"] = message;
        return result;
    }
}

