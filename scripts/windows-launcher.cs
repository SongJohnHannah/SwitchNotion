using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

internal static class NotionSwitchLauncher
{
    [STAThread]
    private static void Main()
    {
        try
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string script = Path.Combine(root, "scripts", "launch.ps1");
            if (!File.Exists(script)) throw new Exception("请先完整解压 NotionSwitch，再双击启动程序。");
            string name = Path.GetFileNameWithoutExtension(Assembly.GetExecutingAssembly().Location);
            string target = name.Contains("配置") ? "settings" : name.Contains("更新") ? "update" : "notion";
            Process.Start(new ProcessStartInfo
            {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe"),
                Arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File \"" + script + "\" -Target " + target,
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            });
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "Switch Notion", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
    }
}
