export interface ExpandSelection {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExpandPayload {
  imageBase64: string;
  maskBase64: string;
  width: number;
  height: number;
  selection: ExpandSelection;
  originalImageBase64: string;
  originalWidth: number;
  originalHeight: number;
}

export interface ExpandPadding {
  top: number;
  bottom: number;
  left: number;
  right: number;
}
