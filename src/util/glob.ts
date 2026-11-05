export function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function globToRegExp(glob: string, platform: NodeJS.Platform): RegExp {
  const source = normalizePath(platform === "win32" ? glob.toLowerCase() : glob);
  let pattern = "";
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (char === "*") {
      if (source[index + 1] === "*") {
        pattern += ".*";
        index++;
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${pattern}$`);
}
