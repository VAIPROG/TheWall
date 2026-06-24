/** Typed errors thrown by the format decoders, so callers can branch on cause
 *  (e.g. show a "not a recognised file" dialog vs a "no templates" dialog). */
class FormatError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}
export class UnknownFormatError extends FormatError {
  constructor(message = "unrecognised payload") { super("UnknownFormatError", message); }
}
export class MalformedPayloadError extends FormatError {
  constructor(message = "payload is malformed") { super("MalformedPayloadError", message); }
}
export class NoTemplatesError extends FormatError {
  constructor(message = "no templates in payload") { super("NoTemplatesError", message); }
}
export class ImageLoadFailedError extends FormatError {
  constructor(message = "no image source could be loaded") { super("ImageLoadFailedError", message); }
}
