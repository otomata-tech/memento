/**
 * Memento V3 — base (KB) sélectionnée, partagée par toutes les vues v3.
 * Une org = une base (ADR 0003) ; l'utilisateur en choisit une dans le sélecteur du
 * layout, les vues (Pages/Search/Inbox) lisent `currentBase`. Persisté en localStorage.
 * Reactive module simple (pas de store Pinia) — un seul état transverse, léger.
 */
import { ref } from "vue";
import { apiV3, type BaseRef } from "../api.v3";

const LS_KEY = "memento.v3.base";

export const bases = ref<BaseRef[]>([]);
export const currentBase = ref<string>(localStorage.getItem(LS_KEY) ?? "");
export const basesLoaded = ref(false);

export function setBase(id: string) {
  currentBase.value = id;
  if (id) localStorage.setItem(LS_KEY, id); else localStorage.removeItem(LS_KEY);
}

/** Charge la liste des bases accessibles ; choisit la 1re si rien de valide en mémoire. */
export async function loadBases(): Promise<void> {
  bases.value = await apiV3.bases();
  const valid = bases.value.some((b) => b.id === currentBase.value);
  if (!valid) setBase(bases.value[0]?.id ?? "");
  basesLoaded.value = true;
}

export function currentBaseRef(): BaseRef | undefined {
  return bases.value.find((b) => b.id === currentBase.value);
}
