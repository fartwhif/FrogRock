import { Transform } from 'stream';
import { stringify } from 'ecma-iceclient';

const META_BLOCK_SIZE = 16;
const MAX_LENGTH = META_BLOCK_SIZE * 255;
const NO_METADATA = Buffer.from([0]);

interface IcyMetadata {
  StreamTitle?: string;
  [key: string]: string | undefined;
}

class Writer extends Transform {
  public metaint: number;
  private _bytesSinceMeta: number = 0;
  private _buffer: Buffer = Buffer.alloc(0);
  private _metadata: Buffer = NO_METADATA;

  constructor(metaint: number, opts?: object) {
    if (!isFinite(metaint)) {
      throw new Error('Writer requires a "metaint" number');
    }
    super(opts);
    this.metaint = +metaint;
  }

  queue(metadata: string | IcyMetadata): void {
    if (typeof metadata === 'string') {
      metadata = { StreamTitle: metadata };
    } else if (metadata && Object(metadata) === metadata) {
      // ok
    } else {
      throw new TypeError('don\'t know how to format metadata: ' + metadata);
    }
    if (!('StreamTitle' in metadata)) {
      throw new TypeError('a "StreamTitle" property is required for metadata');
    }
    const str = stringify(metadata);
    const len = Buffer.byteLength(str);
    if (len > MAX_LENGTH) {
      throw new Error('metadata must be <= 4080, got: ' + len);
    }
    const meta = Math.ceil(len / META_BLOCK_SIZE);
    const buf = Buffer.alloc(meta * META_BLOCK_SIZE + 1);
    buf[0] = meta;
    const written = buf.write(str, 1);
    for (let i = written + 1; i < buf.length; i++) {
      buf[i] = 0;
    }
    this._metadata = buf;
  }

  queueMetadata(metadata: string | IcyMetadata): void {
    this.queue(metadata);
  }

  _transform(chunk: Buffer, _encoding: string, callback: (err?: Error, data?: Buffer | Buffer[]) => void): void {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    const output: Buffer[] = [];
    let offset = 0;

    while (offset < this._buffer.length) {
      const remaining = this._buffer.length - offset;
      const distToMeta = this.metaint - this._bytesSinceMeta;

      if (distToMeta <= 0) {
        output.push(this._metadata);
        this._bytesSinceMeta = 0;
        continue;
      }

      if (remaining <= distToMeta) {
        output.push(this._buffer.slice(offset));
        this._bytesSinceMeta += remaining;
        offset = this._buffer.length;
      } else {
        output.push(this._buffer.slice(offset, offset + distToMeta));
        offset += distToMeta;
        this._bytesSinceMeta = this.metaint;
      }
    }

    const leftover = this._buffer.length - offset;
    if (leftover > 0) {
      this._buffer = this._buffer.slice(offset);
    } else {
      this._buffer = Buffer.alloc(0);
    }

    callback(undefined, Buffer.concat(output));
  }
}

export { Writer };
export default Writer;
