/** Text from a file, a command or a repository made safe to hand to the terminal: control characters other than tab and line feed become `?`. */
export const printable = (text: string): string => text.replace(/(?![\t\n])\p{Cc}/gu, "?");

/** Text with its control characters removed, except tab, line feed and carriage return. */
export const stripControl = (text: string): string => text.replace(/(?![\t\n\r])\p{Cc}/gu, "");
