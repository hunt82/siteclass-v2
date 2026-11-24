export type AssessmentType = "ESA" | "PCA" | "DUAL";
export type AspectChoice = "3:4" | "4:3" | "16:9";
export type PhotoSource = "app" | "camera-app" | "library";

export interface CategoryDef {
  id: string;
  system: "ESA" | "PCA";
  num: number;
  label: string;
  short: string;
  hint: string;
  folder: string;
  group: "ESA" | "Site" | "Building" | "Systems" | "Units";
  tags: string[];
}

export interface GpsFix {
  lat: number;
  lng: number;
  accuracy?: number;
  at?: number;
}

export interface PhotoRecord {
  id: string;
  categoryId: string;
  createdAt: string;
  note: string;
  tags: string[];
  deficient?: boolean;
  name: string;
  aspect: string;
  source: PhotoSource;
  bytes: number;
  width?: number;
  height?: number;
  lat?: number;
  lng?: number;
  accuracy?: number;
}

export interface ProjectRecord {
  id: string;
  name: string;
  address: string;
  inspector: string;
  projectNo: string;
  type: AssessmentType;
  siteNotes: string;
  createdAt: string;
  updatedAt: string;
  armedCategoryId: string;
  photos: PhotoRecord[];
}
