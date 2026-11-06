param([Parameter(Mandatory=$true)][string]$Executable, [Parameter(Mandatory=$true)][string]$Icon)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class SwitchNotionIconResources {
 delegate bool NameCallback(IntPtr module, IntPtr type, IntPtr name, IntPtr parameter);
 delegate bool LanguageCallback(IntPtr module, IntPtr type, IntPtr name, ushort language, IntPtr parameter);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibraryEx(string file, IntPtr reserved, uint flags);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool FreeLibrary(IntPtr module);
 [DllImport("kernel32.dll", EntryPoint="EnumResourceNamesW", SetLastError=true)] static extern bool EnumResourceNames(IntPtr module, IntPtr type, NameCallback callback, IntPtr parameter);
 [DllImport("kernel32.dll", EntryPoint="EnumResourceLanguagesW", SetLastError=true)] static extern bool EnumResourceLanguages(IntPtr module, IntPtr type, IntPtr name, LanguageCallback callback, IntPtr parameter);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr BeginUpdateResource(string file, bool deleteExisting);
 [DllImport("kernel32.dll", EntryPoint="UpdateResourceW", SetLastError=true)] static extern bool UpdateResource(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] bytes, uint size);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool EndUpdateResource(IntPtr update, bool discard);
 sealed class Group { public int Id; public string Name; public ushort Language; }
 static Exception Error(string action) { return new Win32Exception(Marshal.GetLastWin32Error(), action); }
 public static void Apply(string executable, string icon) {
  byte[] ico=File.ReadAllBytes(icon);
  if(ico.Length<6 || BitConverter.ToUInt16(ico,0)!=0 || BitConverter.ToUInt16(ico,2)!=1) throw new InvalidDataException("Invalid ICO header");
  int count=BitConverter.ToUInt16(ico,4); if(count<1 || count>256 || ico.Length<6+16*count) throw new InvalidDataException("Invalid ICO directory");
  var frames=new List<byte[]>();
  for(int i=0;i<count;i++){int entry=6+16*i;uint size=BitConverter.ToUInt32(ico,entry+8),offset=BitConverter.ToUInt32(ico,entry+12);if(size==0 || size>int.MaxValue || (ulong)offset+size>(ulong)ico.Length)throw new InvalidDataException("Invalid ICO frame");var bytes=new byte[(int)size];Buffer.BlockCopy(ico,(int)offset,bytes,0,bytes.Length);frames.Add(bytes);}
  var groups=new List<Group>();int maximumId=0;
  IntPtr module=LoadLibraryEx(executable,IntPtr.Zero,0x22);if(module==IntPtr.Zero)throw Error("Read executable icon resources");
  try {
   EnumResourceNames(module,new IntPtr(3),(m,t,n,p)=>{long id=n.ToInt64();if((id>>16)==0)maximumId=Math.Max(maximumId,(int)id);return true;},IntPtr.Zero);
   EnumResourceNames(module,new IntPtr(14),(m,t,n,p)=>{long id=n.ToInt64();string name=(id>>16)==0?null:Marshal.PtrToStringUni(n);bool found=EnumResourceLanguages(m,t,n,(lm,lt,ln,language,lp)=>{groups.Add(new Group{Id=name==null?(int)id:0,Name=name,Language=language});return true;},IntPtr.Zero);if(!found)throw Error("Read icon language");return true;},IntPtr.Zero);
  } finally {FreeLibrary(module);}
  if(groups.Count==0)groups.Add(new Group{Id=1,Language=0});
  if(maximumId+count>65535)throw new InvalidDataException("Icon resource ID limit");
  byte[] directory=new byte[6+14*count];Buffer.BlockCopy(ico,0,directory,0,6);
  for(int i=0;i<count;i++){Buffer.BlockCopy(ico,6+16*i,directory,6+14*i,12);Buffer.BlockCopy(BitConverter.GetBytes((ushort)(maximumId+i+1)),0,directory,6+14*i+12,2);}
  IntPtr update=BeginUpdateResource(executable,false);if(update==IntPtr.Zero)throw Error("Open executable for icon update");
  bool committed=false;
  try {
   var languages=new HashSet<ushort>();foreach(var group in groups)languages.Add(group.Language);
   foreach(ushort language in languages)for(int i=0;i<count;i++)if(!UpdateResource(update,new IntPtr(3),new IntPtr(maximumId+i+1),language,frames[i],(uint)frames[i].Length))throw Error("Write icon frame");
   foreach(var group in groups){IntPtr name=group.Name==null?new IntPtr(group.Id):Marshal.StringToHGlobalUni(group.Name);try{if(!UpdateResource(update,new IntPtr(14),name,group.Language,directory,(uint)directory.Length))throw Error("Write icon group");}finally{if(group.Name!=null)Marshal.FreeHGlobal(name);}}
   if(!EndUpdateResource(update,false))throw Error("Commit executable icon");committed=true;
  } finally {if(!committed)EndUpdateResource(update,true);}
 }
}
'@
[SwitchNotionIconResources]::Apply([IO.Path]::GetFullPath($Executable), [IO.Path]::GetFullPath($Icon))
