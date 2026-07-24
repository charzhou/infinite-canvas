import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import { OidcChannelCard } from "./oidc-channel-card";

it("uses the configured Provider name without an OIDC suffix", () => {
    render(<OidcChannelCard providerName="My Compute" enabled connected={false} />);
    expect(screen.getByRole("button", { name: "连接 My Compute" })).toBeInTheDocument();
    expect(screen.queryByText(/OIDC/)).not.toBeInTheDocument();
});
