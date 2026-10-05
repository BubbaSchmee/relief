declare module "gltf-validator" {
  export interface ValidationMessage {
    code: string;
    message: string;
    severity: number; // 0 error, 1 warning, 2 info, 3 hint
    pointer?: string;
  }
  export interface ValidationReport {
    issues: { numErrors: number; numWarnings: number; numInfos: number; numHints: number; messages: ValidationMessage[] };
  }
  export function validateBytes(data: Uint8Array, options?: Record<string, unknown>): Promise<ValidationReport>;
}
