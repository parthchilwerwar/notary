import type { ComponentProps, ReactNode } from "react";
import { CaretDownIcon as CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
export function SelectControl({
  icon,
  children,
  ...props
}: ComponentProps<"select"> & { icon?: ReactNode }) {
  return (
    <span className={`select-control ${icon ? "with-icon" : ""}`}>
      {icon && (
        <span className="select-leading" aria-hidden="true">
          {icon}
        </span>
      )}
      <select {...props}>{children}</select>
      <CaretDown className="select-chevron" size={16} aria-hidden="true" />
    </span>
  );
}
