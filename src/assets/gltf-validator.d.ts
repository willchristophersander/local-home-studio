declare module 'gltf-validator' {
  export function validateBytes(bytes: Uint8Array, options?: {
    uri?: string;
    format?: 'gltf' | 'glb';
    maxIssues?: number;
    writeTimestamp?: boolean;
    externalResourceFunction?: (uri: string) => Promise<Uint8Array>;
  }): Promise<{ issues: { numErrors: number; numWarnings: number; messages: Array<{ code: string; message: string; severity: number }> } }>;
}
