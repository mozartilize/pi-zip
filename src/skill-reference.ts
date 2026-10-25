// Pi expands /skill:name into this complete user-message wrapper, followed by optional arguments.
// Only match that envelope: quoted examples and malformed/partial blocks must remain untouched.
export function skillReference(text: string): string {
	const match = /^<skill name="([a-z0-9]+(?:-[a-z0-9]+)*)" location="[^"\n]+">\n[\s\S]*?\n<\/skill>(\n\n[\s\S]*)?$/.exec(text);
	if (!match || match[1].length > 64) return text;
	return `/skill:${match[1]}${match[2] ?? ""}`;
}
