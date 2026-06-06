/**
 * morse-table.ts
 * --------------
 * The dictionary half of the decoder: maps dot/dash strings (e.g. ".-") to
 * characters. Pure data + one lookup function. No SDK, no timing logic.
 */

// "." = dot, "-" = dash. Standard international Morse.
const MORSE_TO_CHAR: Record<string, string> = {
  '.-': 'A', '-...': 'B', '-.-.': 'C', '-..': 'D', '.': 'E',
  '..-.': 'F', '--.': 'G', '....': 'H', '..': 'I', '.---': 'J',
  '-.-': 'K', '.-..': 'L', '--': 'M', '-.': 'N', '---': 'O',
  '.--.': 'P', '--.-': 'Q', '.-.': 'R', '...': 'S', '-': 'T',
  '..-': 'U', '...-': 'V', '.--': 'W', '-..-': 'X', '-.--': 'Y',
  '--..': 'Z',
  '-----': '0', '.----': '1', '..---': '2', '...--': '3', '....-': '4',
  '.....': '5', '-....': '6', '--...': '7', '---..': '8', '----.': '9',
  '.-.-.-': '.', '--..--': ',', '..--..': '?', '-..-.': '/',
  '-....-': '-', '.----.': "'", '---...': ':', '-.-.-.': ';',
  '-...-': '=', '.-.-.': '+', '.--.-.': '@',
}

/**
 * Translate a dot/dash sequence to a character.
 * Returns "?" for sequences not in the table (e.g. garbled input).
 */
export function decodeSymbol(symbol: string): string {
  if (symbol.length === 0) return ''
  return MORSE_TO_CHAR[symbol] ?? '?'
}
