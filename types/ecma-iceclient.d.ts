declare module 'ecma-iceclient' {
  interface IcyMetadata {
    StreamTitle?: string;
    [key: string]: string | undefined;
  }
  export function stringify(metadata: IcyMetadata): string;
  export function parse(buffer: Buffer | string): IcyMetadata;
}
