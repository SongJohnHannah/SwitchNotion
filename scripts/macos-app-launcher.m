#import <Cocoa/Cocoa.h>

static int launchRuntime(NSString *bundlePath) {
  NSData *data = [[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
  if (data.length > 1024 * 1024) return 2;
  NSDictionary *input = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![input isKindOfClass:[NSDictionary class]] ||
      ![input[@"environment"] isKindOfClass:[NSDictionary class]] ||
      ![input[@"arguments"] isKindOfClass:[NSArray class]]) return 2;
  for (id key in input[@"environment"]) if (![key isKindOfClass:[NSString class]] || ![input[@"environment"][key] isKindOfClass:[NSString class]]) return 2;
  for (id argument in input[@"arguments"]) if (![argument isKindOfClass:[NSString class]]) return 2;
  NSURL *url = [NSURL fileURLWithPath:bundlePath isDirectory:YES];
  NSBundle *bundle = [NSBundle bundleWithURL:url];
  if (![bundle.bundleIdentifier isEqualToString:@"com.notionswitch.desktop"]) return 2;
  NSApplication *application = [NSApplication sharedApplication];
  NSWorkspaceOpenConfiguration *configuration = [NSWorkspaceOpenConfiguration configuration];
  NSMutableDictionary *environment = [input[@"environment"] mutableCopy];
  // Let LaunchServices assign the child's GUI identity, rather than inherit
  // the enclosing menu-only launcher's identity.
  for (NSString *key in @[@"__CFBundleIdentifier", @"__CFProcessPath", @"XPC_SERVICE_NAME", @"LSASN"]) [environment removeObjectForKey:key];
  configuration.environment = environment;
  configuration.arguments = input[@"arguments"];
  configuration.activates = YES;
  configuration.createsNewApplicationInstance = YES;
  configuration.allowsRunningApplicationSubstitution = NO;
  [[NSWorkspace sharedWorkspace] openApplicationAtURL:url configuration:configuration completionHandler:^(NSRunningApplication *running, NSError *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (running && [running.bundleIdentifier isEqualToString:@"com.notionswitch.desktop"]) {
        printf("%d\n", running.processIdentifier); fflush(stdout); exit(0);
      } else { fprintf(stderr, "Mac runtime launch was not accepted by LaunchServices (code %ld).\n", (long)error.code); }
      exit(1);
    });
  }];
  [application run];
  return 1;
}

static int showError(NSString *message) {
  [NSApplication sharedApplication];
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = @"SwitchNotion 无法启动";
  alert.informativeText = message;
  [alert runModal];
  return 1;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc == 3 && strcmp(argv[1], "--launch-runtime") == 0) return launchRuntime([NSString stringWithUTF8String:argv[2]]);
    NSApplication *application = [NSApplication sharedApplication];
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
    environment[@"NOTION_SWITCH_MAC_LAUNCHER"] = [[NSBundle mainBundle] executablePath];
    task.environment = environment;
    task.terminationHandler = ^(NSTask *finishedTask) {
      int status = finishedTask.terminationStatus;
      dispatch_async(dispatch_get_main_queue(), ^{
        // This helper owns no documents. Terminate after its child finishes,
        // even when completion raced with AppKit's initial launch handling.
        exit(status);
      });
    };
    NSError *error = nil;
    if (![task launchAndReturnError:&error]) return showError(@"无法运行项目启动脚本，请重新运行安装脚本。");
    // LaunchServices must be able to deliver application events while the
    // child prepares and validates the updated Notion bundle.
    [application run];
    return 1;
  }
}
