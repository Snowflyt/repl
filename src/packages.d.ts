declare module "dom-to-image-more" {
  const domtoimage: import("dom-to-image").DomToImage;
  export default domtoimage;
}

declare module "js-untar" {
  export default function untar(buffer: ArrayBuffer): Promise<
    {
      buffer: ArrayBuffer;
      checksum: number;
      devmajor: number;
      devminor: number;
      gid: number;
      gname: string;
      linkname: string;
      mode: string;
      mtime: string;
      name: string;
      namePrefix: string;
      size: number;
      type: string;
      uid: number;
      uname: string;
      ustarFormat: string;
      version: string;
      blob: Blob;
    }[]
  >;
}
