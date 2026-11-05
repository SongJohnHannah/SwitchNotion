using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class NotionSwitchLauncher
{
    [STAThread]
    private static void Main()
    {
        try
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string script = Path.Combine(root, "scripts", "launch.ps1");
            if (!File.Exists(script)) throw new Exception("请先完整解压 NotionSwitch，再双击启动程序。");
            string name = Path.GetFileNameWithoutExtension(Assembly.GetExecutingAssembly().Location);
            string target = name.Contains("配置") ? "settings" : name.Contains("更新") ? "update" : "notion";
            string identity;
            using (SHA256 hash = SHA256.Create())
            {
                identity = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar).ToUpperInvariant()))).Replace("-", "");
            }
            string key = @"Local\NotionSwitchLauncher-" + identity + "-" + target;
            // Create the wake event first so a second click can signal even
            // before the first window has finished constructing.
            using (EventWaitHandle wake = new EventWaitHandle(false, EventResetMode.AutoReset, key + "-show"))
            {
                bool first;
                using (Mutex mutex = new Mutex(true, key, out first))
                {
                    if (!first) { wake.Set(); return; }
                    try
                    {
                        using (LaunchWindow window = new LaunchWindow(root, script, target, wake)) Application.Run(window);
                    }
                    finally { mutex.ReleaseMutex(); }
                }
            }
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "Switch Notion", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
    }
}

internal sealed class LaunchWindow : Form
{
    private const string StatusPrefix = "NOTION_SWITCH_STATUS:";
    private const string ErrorPrefix = "NOTION_SWITCH_ERROR:";
    private readonly string root, script, target;
    private readonly EventWaitHandle wake;
    private readonly Label status;
    private readonly System.Windows.Forms.Timer timer;
    private Process child;
    private string failure;
    private bool finished;

    internal LaunchWindow(string root, string script, string target, EventWaitHandle wake)
    {
        this.root = root; this.script = script; this.target = target; this.wake = wake;
        Text = "NotionSwitch · 正在启动";
        Font = new Font("Microsoft YaHei UI", 10F);
        AutoScaleMode = AutoScaleMode.Dpi;
        ClientSize = new Size(460, 218);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterScreen;
        MaximizeBox = false;
        MinimizeBox = false;
        BackColor = Color.White;
        Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location);

        TableLayoutPanel layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(26, 22, 26, 20), ColumnCount = 1, RowCount = 4 };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 24));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 40));
        Controls.Add(layout);
        Label heading = new Label { Text = target == "settings" ? "正在打开配置中心" : target == "update" ? "正在检查更新" : "正在启动 NotionSwitch", Dock = DockStyle.Fill, Font = new Font(Font.FontFamily, 13F, FontStyle.Bold), Margin = Padding.Empty };
        layout.Controls.Add(heading, 0, 0);
        status = new Label { Text = "正在准备，请稍候…", Dock = DockStyle.Fill, Margin = new Padding(0, 5, 0, 5) };
        layout.Controls.Add(status, 0, 1);
        ProgressBar progress = new ProgressBar { Style = ProgressBarStyle.Marquee, MarqueeAnimationSpeed = 28, Dock = DockStyle.Fill, Margin = new Padding(0, 5, 0, 5) };
        layout.Controls.Add(progress, 0, 2);
        Label hint = new Label { Text = "无需重复双击。关闭此窗口后仍会继续启动。", Dock = DockStyle.Fill, ForeColor = Color.DimGray, Font = new Font(Font.FontFamily, 9F), Margin = new Padding(0, 12, 0, 0) };
        layout.Controls.Add(hint, 0, 3);
        timer = new System.Windows.Forms.Timer { Interval = 150 };
        timer.Tick += Poll;
        Shown += delegate { BeginInvoke(new Action(StartLaunch)); };
        FormClosing += delegate(object sender, FormClosingEventArgs args) { if (!finished) { args.Cancel = true; Hide(); } };
    }

    private void StartLaunch()
    {
        try
        {
            ProcessStartInfo start = new ProcessStartInfo
            {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe"),
                Arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File \"" + script + "\" -Target " + target,
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };
            start.EnvironmentVariables["NOTION_SWITCH_LAUNCHER_UI"] = "1";
            child = new Process { StartInfo = start };
            child.OutputDataReceived += Receive;
            // Drain stderr too, even when a helper emits more than a pipe buffer.
            child.ErrorDataReceived += delegate { };
            child.Start();
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();
            timer.Start();
        }
        catch (Exception error) { Finish(error.Message); }
    }

    private void Receive(object sender, DataReceivedEventArgs args)
    {
        string line = args.Data;
        if (line == null || IsDisposed || Disposing) return;
        try
        {
            if (line.StartsWith(StatusPrefix, StringComparison.Ordinal))
                BeginInvoke(new Action(delegate { if (!finished) status.Text = line.Substring(StatusPrefix.Length); }));
            else if (line.StartsWith(ErrorPrefix, StringComparison.Ordinal))
                BeginInvoke(new Action(delegate { failure = line.Substring(ErrorPrefix.Length); }));
        }
        catch (InvalidOperationException) { }
    }

    private void Poll(object sender, EventArgs args)
    {
        if (wake.WaitOne(0)) { Show(); WindowState = FormWindowState.Normal; Activate(); }
        if (child != null && child.HasExited)
        {
            // The tagged failure message is normally delivered before exit;
            // retain a useful fallback when PowerShell itself cannot start.
            Finish(child.ExitCode == 0 ? null : failure ?? "NotionSwitch 启动未完成。请查看项目内 .notion-switch\\launcher-last.log 后重试。");
        }
    }

    private void Finish(string error)
    {
        timer.Stop();
        finished = true;
        if (error != null)
        {
            Show(); Activate();
            MessageBox.Show(this, error, "NotionSwitch · 启动未完成", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        Close();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) { timer.Dispose(); if (child != null) child.Dispose(); }
        base.Dispose(disposing);
    }
}
