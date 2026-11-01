/** Sizes a textarea to its text, up to its CSS max-height. Height is reset first, or it could only ever grow. */
export function fitToContent(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}
