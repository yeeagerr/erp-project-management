import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import session from "express-session";
import { storage } from "./storage";
import { 
  insertUserSchema, 
  insertTeamSchema, 
  insertTeamMemberSchema, 
  insertProjectSchema, 
  insertTaskSchema,
  insertCommentSchema,
  insertFileSchema,
  insertMessageSchema
} from "@shared/schema";
import { z } from "zod";
import MemoryStore from "memorystore";
import dotenv from 'dotenv';
dotenv.config();

// Extend the Express session to include userId
declare module 'express-session' {
  interface SessionData {
    userId: number;
  }
}

const SessionStore = MemoryStore(session);

// Helper function to convert date strings to actual Date objects
const convertDatesToObjects = (body: any) => {
  const newBody = { ...body };
  
  // Check for date fields and convert them from strings to Date objects
  for (const key in newBody) {
    // Check for common date field names
    if (['startDate', 'dueDate', 'createdAt', 'updatedAt'].includes(key) && newBody[key] && typeof newBody[key] === 'string') {
      try {
        newBody[key] = new Date(newBody[key]);
      } catch (e) {
        // If date parsing fails, leave it as is (validation will catch it)
        console.log(`Failed to parse date: ${key}=${newBody[key]}`);
      }
    }
  }
  
  return newBody;
};

// Helper function to validate request body using zod schema
const validateBody = <T>(schema: z.ZodType<T>) => {
  return (req: Request, res: Response, next: () => void) => {
    try {
      // Convert any date strings to Date objects before validation
      const convertedBody = convertDatesToObjects(req.body);
      req.body = schema.parse(convertedBody);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        console.log("Validation error:", error.errors);
        res.status(400).json({ message: "Validation error", errors: error.errors });
      } else {
        console.error("Internal server error during validation:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    }
  };
};

export async function registerRoutes(app: Express): Promise<Server> {
  // Set up session middleware
  app.use(
    session({
      secret: process.env.SESSION_SECRET || "teamflow-secret",
      resave: false,
      saveUninitialized: false,
      cookie: { secure: process.env.NODE_ENV === "production", maxAge: 24 * 60 * 60 * 1000 },
      store: new SessionStore({ checkPeriod: 86400000 }),
    })
  );
  
  // Authentication middleware
  const requireAuth = (req: Request, res: Response, next: () => void) => {
    if (!req.session.userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    next();
  };
  
  // Authentication routes
  // User registration is only allowed by admin, no public registration endpoint
  
  app.post("/api/auth/login", async (req, res) => {
    try {
      const { username, password } = req.body;
      
      // Hard-coded admin account
      if (username === "admin" && password === "pass123") {
        // Check if admin user exists in database
        let adminUser = await storage.getUserByUsername("admin");
        
        // If admin doesn't exist, create it
        if (!adminUser) {
          adminUser = await storage.createUser({
            username: "admin",
            password: "pass123",
            email: "admin@teamflow.com",
            fullName: "Administrator",
            role: "admin"
          });
        }
        
        // Set session
        req.session.userId = adminUser.id;
        
        // Don't return password
        const { password: _, ...userWithoutPassword } = adminUser;
        
        return res.status(200).json(userWithoutPassword);
      }
      
      // For normal users, only let them log in if they exist
      const user = await storage.getUserByUsername(username);
      if (!user || user.password !== password) {
        return res.status(401).json({ message: "Invalid credentials" });
      }
      
      // Set session
      req.session.userId = user.id;
      
      // Don't return password
      const { password: _, ...userWithoutPassword } = user;
      
      res.status(200).json(userWithoutPassword);
    } catch (error) {
      res.status(500).json({ message: "Failed to login" });
    }
  });
  
  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ message: "Failed to logout" });
      }
      res.status(200).json({ message: "Logged out successfully" });
    });
  });
  
  app.get("/api/auth/me", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      
      // Don't return password
      const { password, ...userWithoutPassword } = user;
      
      res.status(200).json(userWithoutPassword);
    } catch (error) {
      res.status(500).json({ message: "Failed to get user" });
    }
  });
  
  // User routes
  app.get("/api/users", requireAuth, async (req, res) => {
    try {
      const users = await storage.getAllUsers();
      if (!users) {
        return res.status(200).json([]);
      }
      
      // Filter out sensitive information
      const sanitizedUsers = users.map(user => ({
        id: user.id,
        username: user.username,
        email: user.email,
        fullName: user.fullName || user.username,
        avatar: user.avatar,
        role: user.role || 'member',
        userType: user.userType || 'normal'
      }));
      
      res.status(200).json(sanitizedUsers);
    } catch (error) {
      console.error("Error getting users:", error);
      res.status(500).json({ message: "Failed to get users" });
    }
  });
  
  // Admin create user endpoint - only accessible by admin user
  app.post("/api/users", requireAuth, validateBody(insertUserSchema), async (req, res) => {
    try {
      // Check if the current user is admin
      const currentUser = await storage.getUser(req.session.userId!);
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ message: "Only admins can create new users" });
      }
      
      const { username, email } = req.body;
      
      // Check if username already exists
      const existingUserByUsername = await storage.getUserByUsername(username);
      if (existingUserByUsername) {
        return res.status(400).json({ message: "Username already taken" });
      }
      
      // Check if email already exists
      const existingUserByEmail = await storage.getUserByEmail(email);
      if (existingUserByEmail) {
        return res.status(400).json({ message: "Email already in use" });
      }
      
      // Create the user
      const user = await storage.createUser(req.body);
      
      // Don't return password
      const { password, ...userWithoutPassword } = user;
      
      res.status(201).json(userWithoutPassword);
    } catch (error) {
      res.status(500).json({ message: "Failed to create user" });
    }
  });
  
  // Get a specific user
  app.get("/api/users/:id", requireAuth, async (req, res) => {
    try {
      const userId = parseInt(req.params.id);
      const user = await storage.getUser(userId);
      
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      
      // Don't return password
      const { password, ...userWithoutPassword } = user;
      
      res.status(200).json(userWithoutPassword);
    } catch (error) {
      res.status(500).json({ message: "Failed to get user" });
    }
  });
  
  // Update user - only admin or the user themselves
  app.put("/api/users/:id", requireAuth, async (req, res) => {
    try {
      const userId = parseInt(req.params.id);
      const currentUser = await storage.getUser(req.session.userId!);
      
      // Only admins or the user themselves can update the user
      if (req.session.userId !== userId && (!currentUser || currentUser.role !== "admin")) {
        return res.status(403).json({ message: "Not authorized to update this user" });
      }
      
      // Don't allow changing role unless admin
      if (req.body.role && (!currentUser || currentUser.role !== "admin")) {
        return res.status(403).json({ message: "Not authorized to change role" });
      }
      
      const updatedUser = await storage.updateUser(userId, req.body);
      
      if (!updatedUser) {
        return res.status(404).json({ message: "User not found" });
      }
      
      // Don't return password
      const { password, ...userWithoutPassword } = updatedUser;
      
      res.status(200).json(userWithoutPassword);
    } catch (error) {
      res.status(500).json({ message: "Failed to update user" });
    }
  });
  
  // Delete user - only admin
  app.delete("/api/users/:id", requireAuth, async (req, res) => {
    try {
      const userId = parseInt(req.params.id);
      const currentUser = await storage.getUser(req.session.userId!);
      
      // Only admins can delete users
      if (!currentUser || currentUser.role !== "admin") {
        return res.status(403).json({ message: "Not authorized to delete users" });
      }
      
      // Don't allow deleting self
      if (req.session.userId === userId) {
        return res.status(400).json({ message: "Cannot delete your own account" });
      }
      
      const success = await storage.deleteUser(userId);
      
      if (!success) {
        return res.status(404).json({ message: "User not found" });
      }
      
      res.status(200).json({ message: "User deleted successfully" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete user" });
    }
  });
  
  // Team routes
  app.get("/api/teams", requireAuth, async (req, res) => {
    try {
      const teams = await storage.getTeamsByUser(req.session.userId!);
      res.status(200).json(teams || []);
    } catch (error) {
      console.error("Error fetching teams:", error);
      const errorMessage = error instanceof Error ? error.message : "Failed to get teams";
      res.status(500).json({ message: errorMessage });
    }
  });
  
  app.post("/api/teams", requireAuth, validateBody(insertTeamSchema), async (req, res) => {
    try {
      // Get current user role
      const currentUser = await storage.getUser(req.session.userId!);
      if (!currentUser) {
        return res.status(404).json({ message: "User not found" });
      }
      
      // Only admin users can create teams
      if (currentUser.role !== "admin") {
        return res.status(403).json({ message: "Only admin users can create teams" });
      }
      
      const team = await storage.createTeam({
        ...req.body,
        createdBy: req.session.userId!,
      });
      
      // Add the creator as an admin of the team
      await storage.addTeamMember({
        teamId: team.id,
        userId: req.session.userId!,
        role: "admin"
      });
      
      res.status(201).json(team);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ message: errorMessage });
    }
  });
  
  app.get("/api/teams/:id", requireAuth, async (req, res) => {
    try {
      const team = await storage.getTeam(parseInt(req.params.id));
      if (!team) {
        return res.status(404).json({ message: "Team not found" });
      }
      
      res.status(200).json(team);
    } catch (error) {
      res.status(500).json({ message: "Failed to get team one" });
    }
  });
  
  app.put("/api/teams/:id", requireAuth, async (req, res) => {
    try {
      const team = await storage.getTeam(parseInt(req.params.id));
      if (!team) {
        return res.status(404).json({ message: "Team not found" });
      }
      
      // Check if user is admin of the team
      const teamMembers = await storage.getTeamMembers(team.id);
      const currentUserMembership = teamMembers.find(member => member.userId === req.session.userId!);
      
      if (!currentUserMembership || currentUserMembership.role !== "admin") {
        return res.status(403).json({ message: "Not authorized to update team" });
      }
      
      const updatedTeam = await storage.updateTeam(team.id, req.body);
      res.status(200).json(updatedTeam);
    } catch (error) {
      res.status(500).json({ message: "Failed to update team" });
    }
  });
  
  app.delete("/api/teams/:id", requireAuth, async (req, res) => {
    try {
      const team = await storage.getTeam(parseInt(req.params.id));
      if (!team) {
        return res.status(404).json({ message: "Team not found" });
      }
      
      // Check if user is admin of the team
      const teamMembers = await storage.getTeamMembers(team.id);
      const currentUserMembership = teamMembers.find(member => member.userId === req.session.userId!);
      
      if (!currentUserMembership || currentUserMembership.role !== "admin") {
        return res.status(403).json({ message: "Not authorized to delete team" });
      }
      
      await storage.deleteTeam(team.id);
      res.status(200).json({ message: "Team deleted successfully" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete team" });
    }
  });
  
  // Team Members routes
  app.get("/api/teams/:id/members", requireAuth, async (req, res) => {
    try {
      const teamId = parseInt(req.params.id);
      
      // Check if team exists
      const team = await storage.getTeam(teamId);
      if (!team) {
        return res.status(404).json({ message: "Team not found" });
      }
      
      // Check if user is member of the team
      const teamMembers = await storage.getTeamMembers(teamId);
      const isMember = teamMembers.some(member => member.userId === req.session.userId!);
      
      if (!isMember) {
        return res.status(403).json({ message: "Not authorized to view team members" });
      }
      
      res.status(200).json(teamMembers);
    } catch (error) {
      res.status(500).json({ message: "Failed to get team members" });
    }
  });
  
  // Get current user's role in team
  app.get("/api/teams/:id/members/current", requireAuth, async (req, res) => {
    try {
      const teamId = parseInt(req.params.id);
      const userId = req.session.userId!;
      
      // Check if team exists
      const team = await storage.getTeam(teamId);
      if (!team) {
        return res.status(404).json({ message: "Team not found" });
      }
      
      // Find the team member entry for this user
      const teamMembers = await storage.getTeamMembers(teamId);
      const currentMember = teamMembers.find(member => member.userId === userId);
      
      if (!currentMember) {
        return res.status(404).json({ message: "User is not a member of this team" });
      }
      
      res.status(200).json(currentMember);
    } catch (error) {
      res.status(500).json({ message: "Failed to get user role" });
    }
  });
  
  app.post("/api/teams/:id/members", requireAuth, validateBody(insertTeamMemberSchema), async (req, res) => {
    try {
      const teamId = parseInt(req.params.id);
      
      // Check if team exists
      const team = await storage.getTeam(teamId);
      if (!team) {
        return res.status(404).json({ message: "Team not found" });
      }
      
      // Check if user is admin of the team
      const teamMembers = await storage.getTeamMembers(teamId);
      const currentUserMembership = teamMembers.find(member => member.userId === req.session.userId!);
      
      if (!currentUserMembership || currentUserMembership.role !== "admin") {
        return res.status(403).json({ message: "Not authorized to add team members" });
      }
      
      const newTeamMember = await storage.addTeamMember({
        ...req.body,
        teamId,
      });
      
      res.status(201).json(newTeamMember);
    } catch (error) {
      res.status(500).json({ message: "Failed to add team member" });
    }
  });
  
  app.delete("/api/teams/:teamId/members/:userId", requireAuth, async (req, res) => {
    try {
      const teamId = parseInt(req.params.teamId);
      const userId = parseInt(req.params.userId);
      
      // Check if team exists
      const team = await storage.getTeam(teamId);
      if (!team) {
        return res.status(404).json({ message: "Team not found" });
      }
      
      // Check if user is admin of the team or removing themselves
      const teamMembers = await storage.getTeamMembers(teamId);
      const currentUserMembership = teamMembers.find(member => member.userId === req.session.userId!);
      
      if (
        !currentUserMembership || 
        (currentUserMembership.role !== "admin" && req.session.userId !== userId)
      ) {
        return res.status(403).json({ message: "Not authorized to remove team member" });
      }
      
      const result = await storage.removeTeamMember(teamId, userId);
      if (!result) {
        return res.status(404).json({ message: "Team member not found" });
      }
      
      res.status(200).json({ message: "Team member removed successfully" });
    } catch (error) {
      res.status(500).json({ message: "Failed to remove team member" });
    }
  });
  
  // Project routes
  app.get("/api/projects", requireAuth, async (req, res) => {
    try {
      const teamId = req.query.teamId ? parseInt(req.query.teamId as string) : undefined;
      
      if (teamId) {
        // Check if team exists
        const team = await storage.getTeam(teamId);
        if (!team) {
          return res.status(404).json({ message: "Team not found" });
        }
        
        // Check if user is member of the team
        const teamMembers = await storage.getTeamMembers(teamId);
        const isMember = teamMembers.some(member => member.userId === req.session.userId!);
        
        if (!isMember) {
          return res.status(403).json({ message: "Not authorized to view projects" });
        }
        
        const projects = await storage.getProjectsByTeam(teamId);
        res.status(200).json(projects);
      } else {
        // Get all teams the user belongs to
        const teams = await storage.getTeamsByUser(req.session.userId!);
        
        // Get projects for each team
        const projectPromises = teams.map(team => storage.getProjectsByTeam(team.id));
        const projectsByTeam = await Promise.all(projectPromises);
        
        // Flatten the array of projects
        const projects = projectsByTeam.flat();
        
        res.status(200).json(projects);
      }
    } catch (error) {
      res.status(500).json({ message: "Failed to get projects" });
    }
  });
  
  app.post("/api/projects", requireAuth, validateBody(insertProjectSchema), async (req, res) => {
    try {
      const { teamId } = req.body;
      
      // Log the request body for debugging
      console.log("Project creation request body:", JSON.stringify(req.body));
      
      // Check if team exists
      const team = await storage.getTeam(teamId);
      if (!team) {
        return res.status(404).json({ message: "Team not found" });
      }
      
      // Check if user is member of the team
      const teamMembers = await storage.getTeamMembers(teamId);
      const userMembership = teamMembers.find(member => member.userId === req.session.userId!);
      
      if (!userMembership) {
        return res.status(403).json({ message: "Not authorized to create project" });
      }
      
      // Ensure dates are valid Date objects
      if (req.body.startDate && !(req.body.startDate instanceof Date)) {
        req.body.startDate = new Date(req.body.startDate);
      }
      
      if (req.body.dueDate && !(req.body.dueDate instanceof Date)) {
        req.body.dueDate = new Date(req.body.dueDate);
      }
      
      const project = await storage.createProject(req.body);
      
      res.status(201).json(project);
    } catch (error) {
      console.error("Failed to create project:", error);
      res.status(500).json({ 
        message: "Failed to create project", 
        details: error instanceof Error ? error.message : "Unknown error" 
      });
    }
  });
  
  app.get("/api/projects/:id", requireAuth, async (req, res) => {
    try {
      const project = await storage.getProject(parseInt(req.params.id));
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }
      
      // Check if user is member of the team that owns the project
      const teamMembers = await storage.getTeamMembers(project.teamId);
      const isMember = teamMembers.some(member => member.userId === req.session.userId!);
      
      if (!isMember) {
        return res.status(403).json({ message: "Not authorized to view project" });
      }
      
      res.status(200).json(project);
    } catch (error) {
      res.status(500).json({ message: "Failed to get project" });
    }
  });
  
  app.put("/api/projects/:id", requireAuth, async (req, res) => {
    try {
      const project = await storage.getProject(parseInt(req.params.id));
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }
      
      // Check if user is member of the team that owns the project
      const teamMembers = await storage.getTeamMembers(project.teamId);
      const userMembership = teamMembers.find(member => member.userId === req.session.userId!);
      
      if (!userMembership || userMembership.role !== "admin") {
        return res.status(403).json({ message: "Not authorized to update project" });
      }
      
      // Convert date fields to Date objects if they exist in request body
      const projectData = convertDatesToObjects(req.body);
      
      // Log the processed data for debugging
      console.log("Project update data:", JSON.stringify(projectData));
      
      const updatedProject = await storage.updateProject(project.id, projectData);
      res.status(200).json(updatedProject);
    } catch (error) {
      console.error("Failed to update project:", error);
      res.status(500).json({ 
        message: "Failed to update project", 
        details: error instanceof Error ? error.message : "Unknown error" 
      });
    }
  });
  
  app.delete("/api/projects/:id", requireAuth, async (req, res) => {
    try {
      const project = await storage.getProject(parseInt(req.params.id));
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }
      
      // Check if user is admin of the team that owns the project
      const teamMembers = await storage.getTeamMembers(project.teamId);
      const userMembership = teamMembers.find(member => member.userId === req.session.userId!);
      
      if (!userMembership || userMembership.role !== "admin") {
        return res.status(403).json({ message: "Not authorized to delete project" });
      }
      
      await storage.deleteProject(project.id);
      res.status(200).json({ message: "Project deleted successfully" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete project" });
    }
  });
  
  // Task routes
  app.get("/api/tasks", requireAuth, async (req, res) => {
    try {
      const projectId = req.query.projectId ? parseInt(req.query.projectId as string) : undefined;
      const assigneeId = req.query.assigneeId ? parseInt(req.query.assigneeId as string) : undefined;
      
      if (projectId) {
        // Check if project exists
        const project = await storage.getProject(projectId);
        if (!project) {
          return res.status(404).json({ message: "Project not found" });
        }
        
        // Check if user is member of the team that owns the project
        const teamMembers = await storage.getTeamMembers(project.teamId);
        const isMember = teamMembers.some(member => member.userId === req.session.userId!);
        
        if (!isMember) {
          return res.status(403).json({ message: "Not authorized to view tasks" });
        }
        
        const tasks = await storage.getTasksByProject(projectId);
        res.status(200).json(tasks);
      } else if (assigneeId) {
        // Users can only view their own assigned tasks
        if (assigneeId !== req.session.userId!) {
          return res.status(403).json({ message: "Not authorized to view other users' tasks" });
        }
        
        const tasks = await storage.getTasksByAssignee(assigneeId);
        res.status(200).json(tasks);
      } else {
        // Get all tasks assigned to the current user
        const tasks = await storage.getTasksByAssignee(req.session.userId!);
        res.status(200).json(tasks);
      }
    } catch (error) {
      res.status(500).json({ message: "Failed to get tasks" });
    }
  });
  
  app.post("/api/tasks", requireAuth, validateBody(insertTaskSchema), async (req, res) => {
    try {
      const { projectId } = req.body;
      
      // Log the request body for debugging
      console.log("Task creation request body:", JSON.stringify(req.body));
      
      // Check if project exists
      const project = await storage.getProject(projectId);
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }
      
      // Check if user is member of the team that owns the project
      const teamMembers = await storage.getTeamMembers(project.teamId);
      const isMember = teamMembers.some(member => member.userId === req.session.userId!);
      
      if (!isMember) {
        return res.status(403).json({ message: "Not authorized to create task" });
      }
      
      // Use the more generic date conversion function
      const taskData = convertDatesToObjects(req.body);
      
      const task = await storage.createTask(taskData);
      
      res.status(201).json(task);
    } catch (error) {
      console.error("Task creation error:", error);
      res.status(500).json({ 
        message: "Failed to create task", 
        details: error instanceof Error ? error.message : "Unknown error" 
      });
    }
  });
  
  app.get("/api/tasks/:id", requireAuth, async (req, res) => {
    try {
      const task = await storage.getTask(parseInt(req.params.id));
      if (!task) {
        return res.status(404).json({ message: "Task not found" });
      }
      
      // Check if project exists
      const project = await storage.getProject(task.projectId);
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }
      
      // Check if user is member of the team that owns the project
      const teamMembers = await storage.getTeamMembers(project.teamId);
      const isMember = teamMembers.some(member => member.userId === req.session.userId!);
      
      if (!isMember) {
        return res.status(403).json({ message: "Not authorized to view task" });
      }
      
      res.status(200).json(task);
    } catch (error) {
      res.status(500).json({ message: "Failed to get task" });
    }
  });
  
  app.put("/api/tasks/:id", requireAuth, async (req, res) => {
    try {
      const task = await storage.getTask(parseInt(req.params.id));
      if (!task) {
        return res.status(404).json({ message: "Task not found" });
      }
      
      // Check if project exists
      const project = await storage.getProject(task.projectId);
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }
      
      // Check if user is member of the team that owns the project
      const teamMembers = await storage.getTeamMembers(project.teamId);
      const isMember = teamMembers.some(member => member.userId === req.session.userId!);
      
      if (!isMember) {
        return res.status(403).json({ message: "Not authorized to update task" });
      }
      
      // Use the more generic date conversion function
      const taskData = convertDatesToObjects(req.body);
      
      // Log the processed data for debugging
      console.log("Task update data:", JSON.stringify(taskData));
      
      const updatedTask = await storage.updateTask(task.id, taskData);
      res.status(200).json(updatedTask);
    } catch (error) {
      console.error("Task update error:", error);
      res.status(500).json({ 
        message: "Failed to update task", 
        details: error instanceof Error ? error.message : "Unknown error" 
      });
    }
  });
  
  app.put("/api/tasks/:id/status", requireAuth, async (req, res) => {
    try {
      const { status, order } = req.body;
      
      const task = await storage.getTask(parseInt(req.params.id));
      if (!task) {
        return res.status(404).json({ message: "Task not found" });
      }
      
      // Check if project exists
      const project = await storage.getProject(task.projectId);
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }
      
      // Check if user is member of the team that owns the project
      const teamMembers = await storage.getTeamMembers(project.teamId);
      const isMember = teamMembers.some(member => member.userId === req.session.userId!);
      
      if (!isMember) {
        return res.status(403).json({ message: "Not authorized to update task status" });
      }
      
      const updatedTask = await storage.updateTaskStatus(task.id, status, order);
      res.status(200).json(updatedTask);
    } catch (error) {
      res.status(500).json({ message: "Failed to update task status" });
    }
  });
  
  app.delete("/api/tasks/:id", requireAuth, async (req, res) => {
    try {
      const task = await storage.getTask(parseInt(req.params.id));
      if (!task) {
        return res.status(404).json({ message: "Task not found" });
      }
      
      // Check if project exists
      const project = await storage.getProject(task.projectId);
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }
      
      // Check if user is member of the team that owns the project
      const teamMembers = await storage.getTeamMembers(project.teamId);
      const isMember = teamMembers.some(member => member.userId === req.session.userId!);
      
      if (!isMember) {
        return res.status(403).json({ message: "Not authorized to delete task" });
      }
      
      await storage.deleteTask(task.id);
      res.status(200).json({ message: "Task deleted successfully" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete task" });
    }
  });
  
  // Comment routes
  app.get("/api/tasks/:taskId/comments", requireAuth, async (req, res) => {
    try {
      const taskId = parseInt(req.params.taskId);
      
      // Check if task exists
      const task = await storage.getTask(taskId);
      if (!task) {
        return res.status(404).json({ message: "Task not found" });
      }
      
      // Check if project exists
      const project = await storage.getProject(task.projectId);
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }
      
      // Check if user is member of the team that owns the project
      const teamMembers = await storage.getTeamMembers(project.teamId);
      const isMember = teamMembers.some(member => member.userId === req.session.userId!);
      
      if (!isMember) {
        return res.status(403).json({ message: "Not authorized to view comments" });
      }
      
      const comments = await storage.getCommentsByTask(taskId);
      res.status(200).json(comments);
    } catch (error) {
      res.status(500).json({ message: "Failed to get comments" });
    }
  });
  
  app.post("/api/tasks/:taskId/comments", requireAuth, validateBody(insertCommentSchema), async (req, res) => {
    try {
      const taskId = parseInt(req.params.taskId);
      
      // Check if task exists
      const task = await storage.getTask(taskId);
      if (!task) {
        return res.status(404).json({ message: "Task not found" });
      }
      
      // Check if project exists
      const project = await storage.getProject(task.projectId);
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }
      
      // Check if user is member of the team that owns the project
      const teamMembers = await storage.getTeamMembers(project.teamId);
      const isMember = teamMembers.some(member => member.userId === req.session.userId!);
      
      if (!isMember) {
        return res.status(403).json({ message: "Not authorized to add comment" });
      }
      
      const comment = await storage.createComment({
        ...req.body,
        taskId,
        userId: req.session.userId!,
      });
      
      // Get the user for the comment
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(500).json({ message: "Failed to get user" });
      }
      
      // Don't return password
      const { password, ...userWithoutPassword } = user;
      
      res.status(201).json({ ...comment, user: userWithoutPassword });
    } catch (error) {
      res.status(500).json({ message: "Failed to add comment" });
    }
  });
  
  app.delete("/api/comments/:id", requireAuth, async (req, res) => {
    try {
      const commentId = parseInt(req.params.id);
      
      // Find the comment
      const comment = await storage.getComment(commentId);
      
      if (!comment) {
        return res.status(404).json({ message: "Comment not found" });
      }
      
      // Check if the user is the author of the comment
      if (comment.userId !== req.session.userId!) {
        // If not, check if the user is an admin
        const task = await storage.getTask(comment.taskId);
        if (!task) {
          return res.status(404).json({ message: "Task not found" });
        }
        
        const project = await storage.getProject(task.projectId);
        if (!project) {
          return res.status(404).json({ message: "Project not found" });
        }
        
        const teamMembers = await storage.getTeamMembers(project.teamId);
        const userMembership = teamMembers.find(member => member.userId === req.session.userId!);
        
        if (!userMembership || userMembership.role !== "admin") {
          return res.status(403).json({ message: "Not authorized to delete comment" });
        }
      }
      
      await storage.deleteComment(commentId);
      res.status(200).json({ message: "Comment deleted successfully" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete comment" });
    }
  });
  
  // File routes
  app.get("/api/projects/:projectId/files", requireAuth, async (req, res) => {
    try {
      const projectId = parseInt(req.params.projectId);
      
      // Check if project exists
      const project = await storage.getProject(projectId);
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }
      
      // Check if user is member of the team that owns the project
      const teamMembers = await storage.getTeamMembers(project.teamId);
      const isMember = teamMembers.some(member => member.userId === req.session.userId!);
      
      if (!isMember) {
        return res.status(403).json({ message: "Not authorized to view files" });
      }
      
      const files = await storage.getFilesByProject(projectId);
      res.status(200).json(files);
    } catch (error) {
      res.status(500).json({ message: "Failed to get files" });
    }
  });
  
  app.get("/api/tasks/:taskId/files", requireAuth, async (req, res) => {
    try {
      const taskId = parseInt(req.params.taskId);
      
      // Check if task exists
      const task = await storage.getTask(taskId);
      if (!task) {
        return res.status(404).json({ message: "Task not found" });
      }
      
      // Check if project exists
      const project = await storage.getProject(task.projectId);
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }
      
      // Check if user is member of the team that owns the project
      const teamMembers = await storage.getTeamMembers(project.teamId);
      const isMember = teamMembers.some(member => member.userId === req.session.userId!);
      
      if (!isMember) {
        return res.status(403).json({ message: "Not authorized to view files" });
      }
      
      const files = await storage.getFilesByTask(taskId);
      res.status(200).json(files);
    } catch (error) {
      res.status(500).json({ message: "Failed to get files" });
    }
  });
  
  app.post("/api/files", requireAuth, async (req, res) => {
    try {
      // Log the request body for debugging
      console.log("File upload request body:", JSON.stringify(req.body));
      
      const { projectId } = req.body;
      
      // Check if project exists
      const project = await storage.getProject(projectId);
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }
      
      // Check if user is member of the team that owns the project
      const teamMembers = await storage.getTeamMembers(project.teamId);
      const isMember = teamMembers.some(member => member.userId === req.session.userId!);
      
      if (!isMember) {
        return res.status(403).json({ message: "Not authorized to upload file" });
      }
      
      // Manually add uploadedBy to req.body
      const fileData = {
        ...req.body,
        uploadedBy: req.session.userId
      };
      
      // Validate after adding userId
      const validation = insertFileSchema.safeParse(fileData);
      if (!validation.success) {
        console.log("Validation error:", validation.error.format());
        return res.status(400).json({ 
          message: "Validation error", 
          errors: validation.error.errors 
        });
      }
      
      const file = await storage.createFile(fileData);
      
      res.status(201).json(file);
    } catch (error) {
      res.status(500).json({ message: "Failed to upload file" });
    }
  });
  
  app.delete("/api/files/:id", requireAuth, async (req, res) => {
    try {
      const fileId = parseInt(req.params.id);
      
      // Find the file
      const file = await storage.getFile(fileId);
      
      if (!file) {
        return res.status(404).json({ message: "File not found" });
      }
      
      // Check if project exists
      const project = await storage.getProject(file.projectId);
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }
      
      // Check if user is member of the team that owns the project
      const teamMembers = await storage.getTeamMembers(project.teamId);
      const userMembership = teamMembers.find(member => member.userId === req.session.userId!);
      
      if (!userMembership) {
        return res.status(403).json({ message: "Not authorized to delete file" });
      }
      
      // Only the uploader or team admin can delete files
      if (file.uploadedBy !== req.session.userId! && userMembership.role !== "admin") {
        return res.status(403).json({ message: "Not authorized to delete file" });
      }
      
      await storage.deleteFile(fileId);
      res.status(200).json({ message: "File deleted successfully" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete file" });
    }
  });
  
  // Message routes
  app.get("/api/teams/:teamId/messages", requireAuth, async (req, res) => {
    try {
      const teamId = parseInt(req.params.teamId);
      
      // Check if team exists
      const team = await storage.getTeam(teamId);
      if (!team) {
        return res.status(404).json({ message: "Team not found" });
      }
      
      // Check if user is member of the team
      const teamMembers = await storage.getTeamMembers(teamId);
      const isMember = teamMembers.some(member => member.userId === req.session.userId!);
      
      if (!isMember) {
        return res.status(403).json({ message: "Not authorized to view messages" });
      }
      
      const messages = await storage.getMessagesByTeam(teamId);
      
      // Remove password from user objects
      const messagesWithoutPassword = messages.map(message => {
        const { password, ...userWithoutPassword } = message.user;
        return {
          ...message,
          user: userWithoutPassword
        };
      });
      
      res.status(200).json(messagesWithoutPassword);
    } catch (error) {
      res.status(500).json({ message: "Failed to get messages" });
    }
  });
  
  app.post("/api/teams/:teamId/messages", requireAuth, validateBody(insertMessageSchema.omit({ teamId: true, userId: true })), async (req, res) => {
    try {
      const teamId = parseInt(req.params.teamId);
      
      // Check if team exists
      const team = await storage.getTeam(teamId);
      if (!team) {
        return res.status(404).json({ message: "Team not found" });
      }
      
      // Check if user is member of the team
      const teamMembers = await storage.getTeamMembers(teamId);
      const isMember = teamMembers.some(member => member.userId === req.session.userId!);
      
      if (!isMember) {
        return res.status(403).json({ message: "Not authorized to send message" });
      }
      
      const message = await storage.createMessage({
        ...req.body,
        teamId,
        userId: req.session.userId!,
      });
      
      // Get the user for the message
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(500).json({ message: "Failed to get user" });
      }
      
      // Don't return password
      const { password, ...userWithoutPassword } = user;
      
      res.status(201).json({ ...message, user: userWithoutPassword });
    } catch (error) {
      res.status(500).json({ message: "Failed to send message" });
    }
  });
  
  app.delete("/api/messages/:id", requireAuth, async (req, res) => {
    try {
      const messageId = parseInt(req.params.id);
      
      // Find the message
      const message = await storage.getMessage(messageId);
      
      if (!message) {
        return res.status(404).json({ message: "Message not found" });
      }
      
      // Check if the user is the author of the message
      if (message.userId !== req.session.userId!) {
        // If not, check if the user is an admin
        const teamMembers = await storage.getTeamMembers(message.teamId);
        const userMembership = teamMembers.find(member => member.userId === req.session.userId!);
        
        if (!userMembership || userMembership.role !== "admin") {
          return res.status(403).json({ message: "Not authorized to delete message" });
        }
      }
      
      await storage.deleteMessage(messageId);
      res.status(200).json({ message: "Message deleted successfully" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete message" });
    }
  });
  
  const httpServer = createServer(app);
  
  return httpServer;
}
