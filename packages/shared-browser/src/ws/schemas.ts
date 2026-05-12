import z from "zod";

export const exampleMessageToClient = z.object({
	text: z.string(),
})

export type ExampleMessageToClient = z.infer<typeof exampleMessageToClient>

export const exampleMessageToServer = z.object({
	text: z.string(),
})

export type ExampleMessageToServer = z.infer<typeof exampleMessageToServer>
