/**
 * - `container`: the right container (ZIP, compound file) but not a well-formed
 *   package of the declared type, or unreadable within the caps.
 * - `mismatch`: a well-formed package of a DIFFERENT type than declared.
 * - `embedded`: embedded objects or ActiveX controls.
 * - `encrypted`: password-protected, so its contents cannot be checked.
 */
export type DetectResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'signature'
        | 'container'
        | 'mismatch'
        | 'macros'
        | 'embedded'
        | 'encrypted';
    };

/** The Office application a document is declared for, in either container. */
export type OfficeFamily = 'word' | 'excel';
