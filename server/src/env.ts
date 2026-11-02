/** Opt-in, so that a host which never sets NODE_ENV gets the production behaviour. */
export function isDevelopment(): boolean {
  return process.env.NODE_ENV === "development";
}
