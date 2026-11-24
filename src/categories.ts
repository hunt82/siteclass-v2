import { AssessmentType, CategoryDef } from "./types";

export const ESA_CATEGORIES: CategoryDef[] = [
  { id: "elevation", system: "ESA", num: 1, label: "Elevation", short: "Elevation", hint: "Each building face — N, S, E, W", folder: "01-Elevation", group: "ESA", tags: ["North face", "South face", "East face", "West face"] },
  { id: "adjoining", system: "ESA", num: 2, label: "Adjoining", short: "Adjoining", hint: "Adjacent properties and uses", folder: "02-Adjoining", group: "ESA", tags: ["North adjoining", "South adjoining", "East adjoining", "West adjoining"] },
  { id: "ast-ust", system: "ESA", num: 3, label: "AST / UST", short: "Tanks", hint: "Tanks, vents, fill ports, staining", folder: "03-AST-UST", group: "ESA", tags: ["Fill port", "Vent pipe", "Staining", "Secondary containment"] },
];

export const PCA_CATEGORIES: CategoryDef[] = [
  { id: "storm-retaining", system: "PCA", num: 1, label: "Storm water, retaining walls", short: "Storm", hint: "Drainage, outfalls, retaining walls", folder: "01-Storm-and-Retaining-Walls", group: "Site", tags: ["Erosion", "Clogged inlet", "Wall cracking", "Wall leaning"] },
  { id: "access-parking", system: "PCA", num: 2, label: "Site access, parking, pavement", short: "Parking", hint: "Drives, lots, pavement condition", folder: "02-Site-Access-Parking-Pavement", group: "Site", tags: ["Alligator cracking", "Pothole", "Ponding", "Faded striping"] },
  { id: "walks-ramps", system: "PCA", num: 3, label: "Sidewalks, ramps, site steps", short: "Walks", hint: "Walks, ramps, exterior stairs", folder: "03-Sidewalks-Ramps-Site-Steps", group: "Site", tags: ["Trip hazard", "Spalling", "Cracking", "Missing handrail"] },
  { id: "fence-light-sign", system: "PCA", num: 4, label: "Fencing, lighting, signage", short: "Fence", hint: "Fences, site lighting, signs", folder: "04-Fencing-Lighting-Signage", group: "Site", tags: ["Damaged fence", "Light out", "Faded signage", "Leaning post"] },
  { id: "site-amenities", system: "PCA", num: 5, label: "Site amenities", short: "Amenities", hint: "Play, mail, benches, landscaping", folder: "05-Site-Amenities", group: "Site", tags: ["Worn equipment", "Damaged mailboxes", "Overgrown landscaping", "Dead trees"] },
  { id: "utilities", system: "PCA", num: 6, label: "Utilities", short: "Utilities", hint: "Water, sewer, electric, gas", folder: "06-Utilities", group: "Site", tags: ["Meter", "Transformer", "Cleanout", "Backflow preventer"] },
  { id: "garages", system: "PCA", num: 7, label: "Garages, ancillary structures", short: "Garages", hint: "Garages, sheds, accessory buildings", folder: "07-Garages-Ancillary-Structures", group: "Site", tags: ["Roof damage", "Door damage", "Siding damage", "Slab cracking"] },
  { id: "envelope", system: "PCA", num: 8, label: "Framing, cladding, roof", short: "Envelope", hint: "Structure, cladding, roof, flashing", folder: "08-Framing-Cladding-Roof", group: "Building", tags: ["Cracked masonry", "Sealant failure", "Roof wear", "Flashing issue"] },
  { id: "appurtenances", system: "PCA", num: 9, label: "Appurtenances", short: "Appurt.", hint: "Decks, balconies, canopies, stairs", folder: "09-Appurtenances", group: "Building", tags: ["Rotted decking", "Loose railing", "Corrosion", "Canopy damage"] },
  { id: "common-areas", system: "PCA", num: 10, label: "Common areas, amenities", short: "Common", hint: "Lobbies, corridors, shared rooms", folder: "10-Common-Areas-Amenities", group: "Building", tags: ["Worn flooring", "Ceiling stain", "Wall damage", "Dated finishes"] },
  { id: "plumbing", system: "PCA", num: 11, label: "Plumbing", short: "Plumbing", hint: "Supply, waste, water heaters", folder: "11-Plumbing", group: "Systems", tags: ["Water heater", "Active leak", "Corrosion", "Staining"] },
  { id: "hvac", system: "PCA", num: 12, label: "HVAC", short: "HVAC", hint: "Heating, cooling, ventilation", folder: "12-HVAC", group: "Systems", tags: ["Rooftop unit", "Condenser", "Rust / corrosion", "Near end of life"] },
  { id: "fire-safety", system: "PCA", num: 13, label: "Fire and safety", short: "Fire", hint: "Alarms, exits, extinguishers, sprinklers", folder: "13-Fire-and-Safety", group: "Systems", tags: ["Extinguisher", "Exit sign", "Smoke detector", "Sprinkler"] },
  { id: "dwelling-units", system: "PCA", num: 14, label: "Dwelling units", short: "Units", hint: "Typical unit interiors", folder: "14-Dwelling-Units", group: "Units", tags: ["Kitchen", "Bathroom", "Water damage", "Flooring wear"] },
  { id: "ada", system: "PCA", num: 15, label: "ADA", short: "ADA", hint: "Accessible routes, ramps, units", folder: "15-ADA", group: "Units", tags: ["Accessible parking", "Ramp slope", "Accessible route", "Missing signage"] },
];

export const ALL_CATEGORIES: CategoryDef[] = [...ESA_CATEGORIES, ...PCA_CATEGORIES];

export function getCategoriesForType(type: AssessmentType): CategoryDef[] {
  if (type === "ESA") return ESA_CATEGORIES;
  if (type === "PCA") return PCA_CATEGORIES;
  return ALL_CATEGORIES;
}

export function getCategoryById(id: string): CategoryDef {
  return ALL_CATEGORIES.find((c) => c.id === id) ?? PCA_CATEGORIES[1];
}

export function defaultCategoryId(type: AssessmentType): string {
  return type === "PCA" ? "access-parking" : "elevation";
}

export function formatCategoryCode(cat: CategoryDef, type: AssessmentType): string {
  const padded = String(cat.num).padStart(2, "0");
  if (type !== "DUAL") return padded;
  return cat.system === "ESA" ? `E${cat.num}` : `P${padded}`;
}

export function categoryGroupLabel(cat: CategoryDef, type: AssessmentType): string {
  if (cat.system === "ESA") return "ESA";
  return type === "DUAL" ? `PCA · ${cat.group}` : cat.group;
}

export function exportFolderPath(type: AssessmentType, categoryId: string): string {
  const cat = getCategoryById(categoryId);
  return type === "DUAL" ? `${cat.system}/${cat.folder}` : cat.folder;
}
