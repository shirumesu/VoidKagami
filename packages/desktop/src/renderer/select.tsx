import React from "react";
import { Icon } from "./icons.tsx";
import "./select.css";

export function Select({ className = "", children, ...props }: React.ComponentProps<"select">) {
  return <span className={`select-control ${className}`}><select {...props}>{children}</select><Icon name="chevron-down" /></span>;
}
