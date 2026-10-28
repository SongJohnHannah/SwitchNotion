# WeChat Channels sharing links

The sharing-link request sequence is adapted from
[nobiyou/wx_channel v5.6.9](https://github.com/nobiyou/wx_channel/blob/v5.6.9/internal/services/sph_service.go),
under its MIT license. Switch Notion uses its own JavaScript implementation
with an injected browser-session transport. It preserves complete signed media
URLs and does not copy upstream's fixed user/device identifiers or credentials.

This adapter does not include or execute wx_channel.exe, SunnyNet, process
interception drivers, system proxy changes, or root-certificate installation.
The shared-page media path is validated before upload; an encrypted file that
cannot be decoded is reported as incomplete rather than uploaded as a video.

MIT License

Copyright (c) 2025 nobiyou

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
