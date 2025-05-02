export interface Product {
    Id: string; // uuid PRIMARY KEY DEFAULT gen_random_uuid()
    UserId: string; // uuid NOT NULL REFERENCES Users(Id)
    IsArchived: boolean; // boolean NOT NULL DEFAULT false
    CreatedAt: Date | string; // timestamptz NOT NULL DEFAULT now()
    UpdatedAt: Date | string; // timestamptz NOT NULL DEFAULT now()
} 