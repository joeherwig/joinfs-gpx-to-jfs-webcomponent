# Third-party notices

## JoinFS

The `.jfs` recording layout written by this component (file structure, frame types, variable frames, the way
variable IDs are derived from SimVar names, and the string hash used for that) was taken from the source code of
JoinFS, <https://github.com/tuduce/JoinFS>. The hash function in `src/joinfs-gpx-to-jfs.js` (`hashString`) is a
port of JoinFS' `LocalNode.HashString`. JoinFS is licensed under the MIT License:

```
MIT License

Copyright (c) 2025 JoinFS Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

This project is an independent tool. It is not part of, endorsed by or affiliated with JoinFS or its contributors.
"JoinFS", "Microsoft Flight Simulator" and other product names belong to their respective owners.

## Development dependencies

`jsdom`, `@xmldom/xmldom`, `puppeteer-core` and `@sparticuz/chromium` are used by the tests only and are not part
of the distributed component. See their packages for their licenses.
