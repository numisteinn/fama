import { Html } from "@effect/ui/html"

/** DOM ids and refs shared by the add bar, the library and the focus Commands. */
export const FILE_INPUT_ID = "file-input"
export const ADD_TEXT_ID = "add-text"

export const AddTextRef = Html.ref("AddText", "textarea")
export const DeleteConfirmRef = Html.ref("DeleteConfirm", "button")
