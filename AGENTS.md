### Audio Cache Path Normalization

**Context**  
Some audio-related objects contain an `audioPath` property that uses a short cache-relative format (e.g. `"/cache/02WXPNjR-K8/02WXPNjR-K8.mp3"`). These paths must be converted to full local filesystem paths using the `CACHE_DIR` constant.

**Approved Pattern** (use this exact code):

```js
if (item && typeof item.audioPath === 'string' && item.audioPath.startsWith('/cache/')) {
  const relativePath = item.audioPath.substring('/cache/'.length);
  item.audioPath = path.join(CACHE_DIR, relativePath);
}
```

**Why this pattern works**
- `'/cache/'.length` removes the prefix in a self-documenting way (no magic number `7`)
- `path.join()` automatically handles slash normalization
- The result always contains exactly **one** `/cache/` folder at the junction point

**Transformation Example**
- **Before**: `"/cache/02WXPNjR-K8/02WXPNjR-K8.mp3"`
- **After** (when `CACHE_DIR = "/app/cache/"`): `"/app/cache/02WXPNjR-K8/02WXPNjR-K8.mp3"`

**Agent Rules** (you MUST follow these)
- Always use the exact pattern shown above when you encounter `audioPath` starting with `/cache/`
- Never use string concatenation (`+ '/' +`) or manual path joining
- Never hardcode the number `7` — always use `'/cache/'.length`
- Never use `item.audioPath.replace('/cache/', '')` (less clear)
- Apply this transformation as early as possible after receiving the item
- If the path does **not** start with `/cache/`, leave it unchanged

**Do NOT do this**:

```js
// Bad - magic number and unclear
item.audioPath = path.join(CACHE_DIR, item.audioPath.substring(7));

// Bad - manual concatenation
item.audioPath = CACHE_DIR + item.audioPath.substring(7);
```

---

### Windows Batch Files — Echo Statement Rules (Strict & Machine-Readable)

**Context**  
Echo statements in batch files are frequently used to output status messages, version numbers, and file paths. These outputs are often parsed by other tools or humans. To prevent shell metacharacters from causing redirection, command chaining, or parsing errors, all echo text must be strictly controlled.

**Approved Pattern** (follow these exact constraints on every `echo` line)

**Allowed Characters Only**  
The text after `echo ` (or `echo.`) may contain **only**:
- A–Z, a–z, 0–9
- hyphen `-`, underscore `_`
- period `.` (never at the very end — see Rule 2)
- single space (never as the last character)

**Why these constraints exist**
- Prevents accidental redirection (`>`, `|`, `&`)
- Ensures output remains clean and machine-readable
- Eliminates common sources of subtle bugs in generated batch files

**Agent Rules** (you MUST follow these)
- Every echo statement **must end** with a letter (A–Z a–z), a digit (0–9), or a complete variable reference (`%VAR%` or `!VAR!`)
- Use `echo.` (echo immediately followed by a period) **only** for printing a completely blank line
- You **may** use `%VAR%` and `!VAR!` — these count as valid endings
- Always scan every echo line before finishing a file and verify the last character
- If unsure, rewrite the line to match the Valid Examples below

**Valid Examples** (copy these patterns)

```batch
echo Starting installation
echo Version 2-1_0
echo Status is %STATUS%
echo File saved as report.txt
echo Process completed successfully
echo.
echo Current step is 3 of 7
```

**Do NOT do this** (common mistakes)

```batch
echo Installation complete.          ← ends with .
echo Done!                           ← contains forbidden !
echo Press (Y/N) to continue         ← contains parentheses
echo Error: file not found           ← contains colon
echo Hello World                     ← trailing space
echo Status: OK                      ← contains colon
echo Version 1.2.                     ← ends with .
echo Cleanup finished...             ← contains ...
```

**Final Checklist** (run this mentally on every echo line)
1. Does it end with a letter, digit, or variable reference?
2. Are there any forbidden characters (`! & | > < : ; , ? ( ) [ ] { }` etc.)?
3. Is there a trailing space?

If any answer is no, fix the line before proceeding.

**Compliance**

When checking for compliance use something like this to evaluate actual content:

```
# Show exact characters in line 23
$ cd /media/sf_projects/FrogRock && sed -n '23p' serve.bat | od -c
```

### Oracle VirtualBox shared folder glitch
When running commands such as compiling typescript don't allow symlinks because they don't work in the project folder because it's a VirtualBox shared folder.

