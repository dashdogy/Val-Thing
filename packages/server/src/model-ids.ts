const OPENAI_GPT_56_FAMILY_PATTERN = /^gpt-5\.6-(?:sol|terra|luna)$/;
const VAL_OPENAI_GPT_56_FAMILY_PATTERN =
  /^openai-(gpt-5\.6-(?:sol|terra|luna))$/;

export function openAIModelIdForVal(modelId: string) {
  const normalized = modelId.toLowerCase();
  return VAL_OPENAI_GPT_56_FAMILY_PATTERN.exec(normalized)?.[1] ?? modelId;
}

export function valModelIdForOpenAI(modelId: string) {
  const normalized = modelId.toLowerCase();
  return OPENAI_GPT_56_FAMILY_PATTERN.test(normalized)
    ? `openai-${normalized}`
    : modelId;
}
