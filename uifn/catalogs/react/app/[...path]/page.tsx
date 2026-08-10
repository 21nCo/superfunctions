import { workbenchRoutes } from "@uifn/examples-shared";
import CatalogClient from "../catalog-client";

export const dynamicParams = false;

export function generateStaticParams(): Array<{ path: string[] }> {
  return workbenchRoutes
    .filter((route) => route.path !== "/")
    .map((route) => ({
      path: route.path.split("/").filter(Boolean),
    }));
}

export default function CatalogRoutePage() {
  return <CatalogClient />;
}
