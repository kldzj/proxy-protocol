export default class ProtocolError extends Error {
  public header?: string;

  constructor(msg: string) {
    super(msg);
  }
}
