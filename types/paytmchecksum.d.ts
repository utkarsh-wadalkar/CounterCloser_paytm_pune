declare module "paytmchecksum" {
  export default class PaytmChecksum {
    static generateSignature(params: object | string, key: string): Promise<string>;
    static verifySignature(params: object | string, key: string, checksum: string): Promise<boolean>;
  }
}
