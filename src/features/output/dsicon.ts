/** DBMS brand icon of a driver (the explorer's local icon set). */
import type { Driver } from "../../api/db";
import { theme } from "../../state/theme";
import { LOCAL, localIconUrl, providerIcon } from "../explorer/icons";

export const dsIconUrl = (driver: Driver): string | undefined => localIconUrl(providerIcon(driver).slice(LOCAL.length), theme());
