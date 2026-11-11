/** The files a design job needs, uploaded to inputs/ (app/api/jobs/[id]/inputs/[name]). */
export const DESIGN_INPUTS = { 'mockups.zip': 'Mockups (HTML/CSS zip)', 'theme.zip': 'Framework theme (zip)' } as const;
export type DesignInput = keyof typeof DESIGN_INPUTS;
/** Largest upload: the Newport mockups were 196 MB with their .git folder. */
export const MAX_INPUT_BYTES = 600 * 1024 * 1024;
