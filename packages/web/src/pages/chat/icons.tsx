// The icons Chat needs, from Phosphor (decorative: always aria-hidden; the control carries the name).
// Same names and props as before, so every caller keeps working; `strokeWidth` above 1.8 picks the
// bold weight for the small carets and arrows, everything else is the regular weight.
import type { ComponentType } from "react";
import type { IconProps as PhosphorProps } from "@phosphor-icons/react";
import { ArrowDownIcon } from "@phosphor-icons/react/dist/csr/ArrowDown";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { ArrowUpIcon } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { CheckIcon as PhCheck } from "@phosphor-icons/react/dist/csr/Check";
import { CopyIcon as PhCopy } from "@phosphor-icons/react/dist/csr/Copy";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { StopIcon } from "@phosphor-icons/react/dist/csr/Stop";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";

type IconProps = { size?: number; className?: string; strokeWidth?: number };

function icon(Glyph: ComponentType<PhosphorProps>, size: number, weight: PhosphorProps["weight"] = "regular") {
  return function ChatIcon({ size: s, className, strokeWidth }: IconProps) {
    return (
      <Glyph
        size={s ?? size}
        className={className}
        weight={strokeWidth !== undefined && weight !== "fill" ? (strokeWidth > 1.8 ? "bold" : "regular") : weight}
        aria-hidden="true"
        focusable="false"
      />
    );
  };
}

export const CaretRight = icon(CaretRightIcon, 12, "bold");
export const CaretDown = icon(CaretDownIcon, 14, "bold");
export const ArrowUp = icon(ArrowUpIcon, 16, "bold");
export const ArrowDown = icon(ArrowDownIcon, 14, "bold");
export const StopSquare = icon(StopIcon, 12, "fill");
export const Plus = icon(PlusIcon, 16);
export const Trash = icon(TrashIcon, 14);
export const CopyIcon = icon(PhCopy, 14);
export const CheckIcon = icon(PhCheck, 14, "bold");
export const External = icon(ArrowSquareOutIcon, 13);
