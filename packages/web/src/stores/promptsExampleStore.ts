import {type PromptExample } from "@metabox/shared-browser/dto";

export interface PromptsExampleState {
	promptsExamples: PromptExample[];
	selectedPromptExampleId: string | null;
	setSelectedPromptExample: (id: string) => void;
	getPromptExample: (id: string) => PromptExample | undefined;
}
