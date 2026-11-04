import type { Result } from "../result.js";
import { err, ok } from "../result.js";

/**
 * Injectable seam for the native "choose folders" dialog. The Electron main
 * process binds dialog.showOpenDialog; tests inject plain paths. Keeping the
 * dialog behind one call means library logic never touches Electron.
 */

/** The user cancelled the folder dialog (not an error worth reporting). */
export class PickFoldersCancelled extends Error {
  readonly _tag = "PickFoldersCancelled" as const;
  constructor() {
    super("folder selection cancelled");
  }
}

/** Shows a folder picker; resolves to chosen absolute paths. */
export type FolderPicker = () => Promise<Result<string[], PickFoldersCancelled>>;

/**
 * Build a FolderPicker over an Electron-style showOpenDialog function.
 * Kept dependency-free of electron types so the seam is testable.
 */
export function makeElectronFolderPicker(
  showOpenDialog: (opts: {
    title: string;
    properties: ("openDirectory" | "multiSelections")[];
  }) => Promise<{ canceled: boolean; filePaths: string[] }>,
): FolderPicker {
  return async () => {
    const res = await showOpenDialog({
      title: "Add music folders",
      properties: ["openDirectory", "multiSelections"],
    });
    if (res.canceled) return err(new PickFoldersCancelled());
    return ok(res.filePaths);
  };
}
