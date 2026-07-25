export interface Departamento {
  code: string;
  name: string;
}

export interface Municipio {
  departamentoCode: string;
  name: string;
}

/** Colombia's 32 departments plus Bogotá D.C. (which DIVIPOLA treats as its
 * own "departamento" entity, code `'11'`, distinct from Cundinamarca `'25'`
 * even though Bogotá is Cundinamarca's capital) — 33 entries total. Codes are
 * the standard 2-digit DANE/DIVIPOLA department codes (public, well-known
 * reference data; not tenant- or environment-specific). */
export const DEPARTAMENTOS: Departamento[] = [
  { code: '91', name: 'Amazonas' },
  { code: '05', name: 'Antioquia' },
  { code: '81', name: 'Arauca' },
  { code: '08', name: 'Atlántico' },
  { code: '11', name: 'Bogotá, D.C.' },
  { code: '13', name: 'Bolívar' },
  { code: '15', name: 'Boyacá' },
  { code: '17', name: 'Caldas' },
  { code: '18', name: 'Caquetá' },
  { code: '85', name: 'Casanare' },
  { code: '19', name: 'Cauca' },
  { code: '20', name: 'Cesar' },
  { code: '27', name: 'Chocó' },
  { code: '25', name: 'Cundinamarca' },
  { code: '23', name: 'Córdoba' },
  { code: '94', name: 'Guainía' },
  { code: '95', name: 'Guaviare' },
  { code: '41', name: 'Huila' },
  { code: '44', name: 'La Guajira' },
  { code: '47', name: 'Magdalena' },
  { code: '50', name: 'Meta' },
  { code: '52', name: 'Nariño' },
  { code: '54', name: 'Norte de Santander' },
  { code: '86', name: 'Putumayo' },
  { code: '63', name: 'Quindío' },
  { code: '66', name: 'Risaralda' },
  { code: '88', name: 'San Andrés, Providencia y Santa Catalina' },
  { code: '68', name: 'Santander' },
  { code: '70', name: 'Sucre' },
  { code: '73', name: 'Tolima' },
  { code: '76', name: 'Valle del Cauca' },
  { code: '97', name: 'Vaupés' },
  { code: '99', name: 'Vichada' },
];

/** DANE/DIVIPOLA-sourced municipality names per departamento. This is NOT a
 * complete enumeration of Colombia's ~1,100 municipios (that would require a
 * live DANE dataset this environment has no access to fetch) — it covers each
 * departamento's capital plus a handful of other well-known major cities, all
 * with their real departamento attribution, which is enough to exercise
 * checkout address selection and cross-validation for this phase. Extending
 * this list with the remaining municipios later is additive and does not
 * require any schema changes. */
export const MUNICIPIOS: Municipio[] = [
  // Amazonas (91)
  { departamentoCode: '91', name: 'Leticia' },
  { departamentoCode: '91', name: 'Puerto Nariño' },
  // Antioquia (05)
  { departamentoCode: '05', name: 'Medellín' },
  { departamentoCode: '05', name: 'Bello' },
  { departamentoCode: '05', name: 'Itagüí' },
  { departamentoCode: '05', name: 'Envigado' },
  { departamentoCode: '05', name: 'Rionegro' },
  { departamentoCode: '05', name: 'Apartadó' },
  // Arauca (81)
  { departamentoCode: '81', name: 'Arauca' },
  { departamentoCode: '81', name: 'Saravena' },
  // Atlántico (08)
  { departamentoCode: '08', name: 'Barranquilla' },
  { departamentoCode: '08', name: 'Soledad' },
  { departamentoCode: '08', name: 'Malambo' },
  // Bogotá, D.C. (11)
  { departamentoCode: '11', name: 'Bogotá, D.C.' },
  // Bolívar (13)
  { departamentoCode: '13', name: 'Cartagena de Indias' },
  { departamentoCode: '13', name: 'Magangué' },
  { departamentoCode: '13', name: 'Turbaco' },
  // Boyacá (15)
  { departamentoCode: '15', name: 'Tunja' },
  { departamentoCode: '15', name: 'Duitama' },
  { departamentoCode: '15', name: 'Sogamoso' },
  // Caldas (17)
  { departamentoCode: '17', name: 'Manizales' },
  { departamentoCode: '17', name: 'La Dorada' },
  // Caquetá (18)
  { departamentoCode: '18', name: 'Florencia' },
  // Casanare (85)
  { departamentoCode: '85', name: 'Yopal' },
  // Cauca (19)
  { departamentoCode: '19', name: 'Popayán' },
  { departamentoCode: '19', name: 'Santander de Quilichao' },
  // Cesar (20)
  { departamentoCode: '20', name: 'Valledupar' },
  { departamentoCode: '20', name: 'Aguachica' },
  // Chocó (27)
  { departamentoCode: '27', name: 'Quibdó' },
  // Cundinamarca (25)
  { departamentoCode: '25', name: 'Soacha' },
  { departamentoCode: '25', name: 'Zipaquirá' },
  { departamentoCode: '25', name: 'Chía' },
  { departamentoCode: '25', name: 'Facatativá' },
  { departamentoCode: '25', name: 'Fusagasugá' },
  // Córdoba (23)
  { departamentoCode: '23', name: 'Montería' },
  { departamentoCode: '23', name: 'Lorica' },
  // Guainía (94)
  { departamentoCode: '94', name: 'Inírida' },
  // Guaviare (95)
  { departamentoCode: '95', name: 'San José del Guaviare' },
  // Huila (41)
  { departamentoCode: '41', name: 'Neiva' },
  { departamentoCode: '41', name: 'Pitalito' },
  // La Guajira (44)
  { departamentoCode: '44', name: 'Riohacha' },
  { departamentoCode: '44', name: 'Maicao' },
  // Magdalena (47)
  { departamentoCode: '47', name: 'Santa Marta' },
  { departamentoCode: '47', name: 'Ciénaga' },
  // Meta (50)
  { departamentoCode: '50', name: 'Villavicencio' },
  { departamentoCode: '50', name: 'Acacías' },
  // Nariño (52)
  { departamentoCode: '52', name: 'Pasto' },
  { departamentoCode: '52', name: 'Ipiales' },
  // Norte de Santander (54)
  { departamentoCode: '54', name: 'Cúcuta' },
  { departamentoCode: '54', name: 'Ocaña' },
  // Putumayo (86)
  { departamentoCode: '86', name: 'Mocoa' },
  // Quindío (63)
  { departamentoCode: '63', name: 'Armenia' },
  { departamentoCode: '63', name: 'Calarcá' },
  // Risaralda (66)
  { departamentoCode: '66', name: 'Pereira' },
  { departamentoCode: '66', name: 'Dosquebradas' },
  // San Andrés, Providencia y Santa Catalina (88)
  { departamentoCode: '88', name: 'San Andrés' },
  { departamentoCode: '88', name: 'Providencia' },
  // Santander (68)
  { departamentoCode: '68', name: 'Bucaramanga' },
  { departamentoCode: '68', name: 'Floridablanca' },
  { departamentoCode: '68', name: 'Girón' },
  { departamentoCode: '68', name: 'Barrancabermeja' },
  // Sucre (70)
  { departamentoCode: '70', name: 'Sincelejo' },
  // Tolima (73)
  { departamentoCode: '73', name: 'Ibagué' },
  { departamentoCode: '73', name: 'Espinal' },
  // Valle del Cauca (76)
  { departamentoCode: '76', name: 'Cali' },
  { departamentoCode: '76', name: 'Palmira' },
  { departamentoCode: '76', name: 'Buenaventura' },
  { departamentoCode: '76', name: 'Tuluá' },
  { departamentoCode: '76', name: 'Cartago' },
  // Vaupés (97)
  { departamentoCode: '97', name: 'Mitú' },
  // Vichada (99)
  { departamentoCode: '99', name: 'Puerto Carreño' },
];

export function municipiosFor(departamentoCode: string): Municipio[] {
  return MUNICIPIOS.filter((m) => m.departamentoCode === departamentoCode);
}
