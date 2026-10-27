#import <Cocoa/Cocoa.h>

static int showError(NSString *message) {
  [NSApplication sharedApplication];
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = @"SwitchNotion 无法启动";
  alert.informativeText = message;
  [alert runModal];
  return 1;
}

int main(void) {
  @autoreleasepool {
    NSString *project = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"SwitchNotionProjectPath"];
    NSString *launcher = [project stringByAppendingPathComponent:@"scripts/launch-macos.sh"];
    if (!project.length || ![[NSFileManager defaultManager] isReadableFileAtPath:launcher]) {
      return showError(@"无法读取项目文件夹。请在系统提示中允许访问，或从项目的新位置重新运行安装脚本。");
    }
    NSTask *task = [[NSTask alloc] init];
    task.executableURL = [NSURL fileURLWithPath:@"/bin/sh"];
    task.arguments = @[launcher, @"notion", project];
    NSMutableDictionary *environment = [[[NSProcessInfo processInfo] environment] mutableCopy];
    environment[@"NOTION_SWITCH_ROOT"] = [project stringByAppendingPathComponent:@".notion-switch/mac-arm64"];
    task.environment = environment;
    NSError *error = nil;
    if (![task launchAndReturnError:&error]) return showError(@"无法运行项目启动脚本，请重新运行安装脚本。");
    [task waitUntilExit];
    return task.terminationStatus;
  }
}
