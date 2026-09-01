-- CreateEnum
CREATE TYPE "IdType" AS ENUM ('AADHAAR', 'PASSPORT', 'DRIVING_LICENSE', 'VOTER_ID', 'OTHER');

-- CreateEnum
CREATE TYPE "RegistrationStatus" AS ENUM ('PENDING', 'APPROVED', 'CHECKED_IN', 'REJECTED');

-- CreateTable
CREATE TABLE "StaffUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Registration" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "dob" TEXT,
    "gender" TEXT,
    "nationality" TEXT,
    "idType" "IdType" NOT NULL DEFAULT 'AADHAAR',
    "idNumber" TEXT,
    "address" TEXT,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "checkInDate" TIMESTAMP(3),
    "checkOutDate" TIMESTAMP(3),
    "purposeOfVisit" TEXT,
    "vehicleNumber" TEXT,
    "numberOfGuests" INTEGER NOT NULL DEFAULT 1,
    "idDocumentImagePath" TEXT,
    "ocrRawText" TEXT,
    "status" "RegistrationStatus" NOT NULL DEFAULT 'PENDING',
    "consentGiven" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedByStaffId" TEXT,

    CONSTRAINT "Registration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StaffUser_email_key" ON "StaffUser"("email");

-- AddForeignKey
ALTER TABLE "Registration" ADD CONSTRAINT "Registration_reviewedByStaffId_fkey" FOREIGN KEY ("reviewedByStaffId") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
