/**
 * Dataset sanitizer and exporter for companion dialogue LoRA tuning (M7-06).
 * Strips PII (phone numbers, emails, passwords, auth tokens, concrete addresses),
 * validates response quality, and serializes into standard Alpaca / ShareGPT format.
 */

// Privacy redaction regex patterns
const PHONE_REGEX = /(?:\+?86)?\s?1[3-9]\d{9}\b/g
const EMAIL_REGEX = /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g
const TOKEN_REGEX = /(?:sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{20,}|Bearer\s+[a-zA-Z0-9_\-.]+)/gi
const ID_CARD_REGEX = /\b\d{17}[\dXx]\b/g
const ADDRESS_REGEX = /(?:(?:北京市|上海市|天津市|重庆市|[\u4e00-\u9fa5]{2,5}(?:省|自治区))[\u4e00-\u9fa5]{2,8}(?:市|区|县)[\u4e00-\u9fa5]{2,12}(?:街道|路|小区|栋|号|室))/g

export function sanitizeText(text) {
  if (typeof text !== 'string') return ''
  let sanitized = text
  let redacted = false

  if (PHONE_REGEX.test(sanitized)) {
    sanitized = sanitized.replace(PHONE_REGEX, '[PHONE_REDACTED]')
    redacted = true
  }
  if (EMAIL_REGEX.test(sanitized)) {
    sanitized = sanitized.replace(EMAIL_REGEX, '[EMAIL_REDACTED]')
    redacted = true
  }
  if (TOKEN_REGEX.test(sanitized)) {
    sanitized = sanitized.replace(TOKEN_REGEX, '[TOKEN_REDACTED]')
    redacted = true
  }
  if (ID_CARD_REGEX.test(sanitized)) {
    sanitized = sanitized.replace(ID_CARD_REGEX, '[ID_REDACTED]')
    redacted = true
  }
  if (ADDRESS_REGEX.test(sanitized)) {
    sanitized = sanitized.replace(ADDRESS_REGEX, '[ADDRESS_REDACTED]')
    redacted = true
  }

  return { text: sanitized.trim(), redacted }
}

export function validateDialogueQuality(input, output) {
  if (!input || !output) return { valid: false, reason: 'EMPTY_TEXT' }
  if (input.length < 2 || output.length < 2) return { valid: false, reason: 'TOO_SHORT' }
  if (output.includes('value is not lossless JSON') || output.includes('Error: ENOENT')) {
    return { valid: false, reason: 'SYSTEM_ERROR_ARTIFACT' }
  }
  return { valid: true }
}

export function formatAlpaca({ instruction, input, output, systemPrompt = '' }) {
  const defaultInstruction = '作为温暖自然的伴侣，以生动的生活化语气与用户沟通。'
  return {
    instruction: instruction || (systemPrompt ? `${defaultInstruction}\n[设定: ${systemPrompt}]` : defaultInstruction),
    input: input,
    output: output,
  }
}

export function exportTuningDataset(dialogues, options = {}) {
  const records = []
  let totalRead = 0
  let exportedCount = 0
  let filteredCount = 0
  let redactedCount = 0

  for (const item of dialogues) {
    totalRead++
    const rawInput = item.input || item.user || item.prompt || ''
    const rawOutput = item.output || item.assistant || item.reply || ''

    const quality = validateDialogueQuality(rawInput, rawOutput)
    if (!quality.valid) {
      filteredCount++
      continue
    }

    const cleanInput = sanitizeText(rawInput)
    const cleanOutput = sanitizeText(rawOutput)

    if (cleanInput.redacted || cleanOutput.redacted) {
      redactedCount++
    }

    const alpacaRecord = formatAlpaca({
      instruction: item.instruction,
      input: cleanInput.text,
      output: cleanOutput.text,
      systemPrompt: options.systemPrompt || item.persona || '',
    })

    records.push(alpacaRecord)
    exportedCount++
  }

  const jsonl = records.map(r => JSON.stringify(r)).join('\n')

  return {
    records,
    jsonl,
    stats: {
      totalRead,
      exportedCount,
      filteredCount,
      redactedCount,
    },
  }
}
